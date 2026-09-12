--[[
  terminalmcp_bridge — client side.

  Two jobs, both driven from the server:
    terminalmcp:exec   run a command exactly as if it were typed into F8
    terminalmcp:eval   evaluate Lua here and send the value back

  Nothing here listens to anything but the server, so a player cannot use it
  to run code on somebody else's machine.
]]

RegisterNetEvent('terminalmcp:exec', function(command)
  if type(command) ~= 'string' or command == '' then return end
  -- This is exactly what pressing Enter in the F8 console does.
  ExecuteCommand(command)
end)

RegisterNetEvent('terminalmcp:eval', function(id, code)
  if type(code) ~= 'string' or code == '' then
    TriggerServerEvent('terminalmcp:result', id, false, 'no code')
    return
  end

  -- Expression first ("GetEntityCoords(PlayerPedId())"), then a block with a
  -- return in it, so both shapes work without the caller having to say which.
  local chunk, err = load('return ' .. code, '@terminalmcp', 't')
  if not chunk then chunk, err = load(code, '@terminalmcp', 't') end
  if not chunk then
    TriggerServerEvent('terminalmcp:result', id, false, 'syntax error: ' .. tostring(err))
    return
  end

  local ok, value = pcall(chunk)
  if not ok then
    TriggerServerEvent('terminalmcp:result', id, false, tostring(value))
    return
  end

  -- Vectors and entities do not survive the trip as they are, so make them
  -- readable rather than dropping them.
  local t = type(value)
  if t == 'vector3' then
    value = { x = value.x, y = value.y, z = value.z }
  elseif t == 'vector4' then
    value = { x = value.x, y = value.y, z = value.z, w = value.w }
  elseif t == 'function' or t == 'thread' or t == 'userdata' then
    value = tostring(value)
  end

  TriggerServerEvent('terminalmcp:result', id, true, value)
end)
