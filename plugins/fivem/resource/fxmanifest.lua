fx_version 'cerulean'
game { 'gta5', 'rdr3' }
rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.'

name 'terminalmcp_bridge'
author 'TerminalMCP'
description 'Optional bridge that lets TerminalMCP run commands in a player F8 console and evaluate Lua on the server or a client.'
version '0.1.0'

server_script 'server.lua'
client_script 'client.lua'
