--[[
  terminalmcp_bridge — server side.

  Exposes a tiny HTTP API on the FXServer's own port so TerminalMCP can:
    * run a command in a specific player's F8 console
    * evaluate Lua on a client and get the value back
    * evaluate Lua on the server and get the value back

  Every request must carry the shared secret from server.cfg. Without
  `set terminalmcp_secret "…"` the resource refuses to start, because a bridge
  with no secret is a remote code execution endpoint on a public port.

  Read the README before installing this. It is powerful on purpose.
]]

local SECRET = GetConvar('terminalmcp_secret', '')
local VERSION = '0.1.0'
local pending = {}
local nextId = 0

if SECRET == '' or #SECRET < 16 then
  print('^1[terminalmcp_bridge] refusing to start: set terminalmcp_secret in server.cfg to a random string of at least 16 characters.^7')
  print('^3[terminalmcp_bridge] example: set terminalmcp_secret "' .. tostring(math.random(1e15, 9e15)) .. tostring(math.random(1e15, 9e15)) .. '"^7')
  return
end

print('^2[terminalmcp_bridge] ready — v' .. VERSION .. ', listening on this server\'s HTTP port^7')

--- Reply helper: always JSON, always a status code.
local function reply(res, code, body)
  res.writeHead(code, { ['Content-Type'] = 'application/json' })
  res.send(json.encode(body))
end

--- Wait for a client to answer, or give up. Returns ok, value.
local function await(id, timeoutMs)
  local deadline = GetGameTimer() + (timeoutMs or 15000)
  while pending[id] ~= nil and pending[id].done ~= true do
    if GetGameTimer() > deadline then
      pending[id] = nil
      return false, 'the client did not answer in time (is it still connected?)'
    end
    Wait(25)
  end
  local entry = pending[id]
  pending[id] = nil
  if entry == nil then return false, 'the request was dropped' end
  if entry.err then return false, entry.err end
  return true, entry.value
end

--- Turn "1" or 1 into a connected player id, or nil plus a reason.
local function resolvePlayer(given)
  local id = tonumber(given)
  if id == nil then return nil, 'player must be a numeric server id' end
  for _, pid in ipairs(GetPlayers()) do
    if tonumber(pid) == id then return id end
  end
  return nil, 'player ' .. tostring(given) .. ' is not connected'
end

SetHttpHandler(function(req, res)
  -- The path arrives as /<endpoint>, with the resource name already stripped.
  local endpoint = req.path:gsub('^/', ''):gsub('/$', '')

  if req.headers['X-Terminalmcp-Secret'] ~= SECRET and req.headers['x-terminalmcp-secret'] ~= SECRET then
    return reply(res, 401, { ok = false, error = 'bad or missing secret' })
  end

  req.setDataHandler(function(body)
    local data = {}
    if body ~= nil and body ~= '' then
      local ok, parsed = pcall(json.decode, body)
      if ok and type(parsed) == 'table' then data = parsed end
    end

    if endpoint == 'ping' then
      return reply(res, 200, {
        ok = true,
        version = VERSION,
        resource = GetCurrentResourceName(),
        players = #GetPlayers(),
      })
    end

    if endpoint == 'client_exec' then
      local id, why = resolvePlayer(data.player)
      if id == nil then return reply(res, 200, { ok = false, error = why }) end
      if type(data.command) ~= 'string' or data.command == '' then
        return reply(res, 200, { ok = false, error = 'command is required' })
      end
      TriggerClientEvent('terminalmcp:exec', id, data.command)
      return reply(res, 200, {
        ok = true,
        note = 'The command was run in that client\'s console. FiveM gives no way to read the console back, so look at that machine\'s CitizenFX.log (action "f8") for what it printed.',
      })
    end

    if endpoint == 'client_lua' then
      local id, why = resolvePlayer(data.player)
      if id == nil then return reply(res, 200, { ok = false, error = why }) end
      if type(data.lua) ~= 'string' or data.lua == '' then
        return reply(res, 200, { ok = false, error = 'lua is required' })
      end

      nextId = nextId + 1
      local id2 = nextId
      pending[id2] = { done = false }
      TriggerClientEvent('terminalmcp:eval', id, id2, data.lua)

      -- The HTTP handler runs in its own coroutine, so waiting here is fine.
      local ok, value = await(id2, tonumber(data.timeout_ms) or 15000)
      if not ok then return reply(res, 200, { ok = false, error = value }) end
      return reply(res, 200, { ok = true, result = value })
    end

    if endpoint == 'server_lua' then
      if type(data.lua) ~= 'string' or data.lua == '' then
        return reply(res, 200, { ok = false, error = 'lua is required' })
      end
      -- Compile as an expression first so `GetPlayers()` works as written,
      -- then fall back to a statement block for `local x = …; return x`.
      local chunk, err = load('return ' .. data.lua, '@terminalmcp', 't')
      if not chunk then chunk, err = load(data.lua, '@terminalmcp', 't') end
      if not chunk then return reply(res, 200, { ok = false, error = 'syntax error: ' .. tostring(err) }) end

      local ok, value = pcall(chunk)
      if not ok then return reply(res, 200, { ok = false, error = tostring(value) }) end
      return reply(res, 200, { ok = true, result = value })
    end

    return reply(res, 404, { ok = false, error = 'unknown endpoint "' .. endpoint .. '"' })
  end)
end)

RegisterNetEvent('terminalmcp:result', function(id, ok, value)
  -- Only ever completes a request this server started, so a malicious client
  -- cannot invent results for requests that were never made.
  local entry = pending[id]
  if entry == nil or entry.done then return end
  entry.done = true
  if ok then entry.value = value else entry.err = tostring(value) end
end)
