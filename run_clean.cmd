@echo off
set ELECTRON_RUN_AS_NODE=
node_modules\electron\dist\electron.exe -e "console.log(JSON.stringify({type:process.type,electronVer:process.versions.electron,env:process.env.ELECTRON_RUN_AS_NODE}))" > e_result.json 2>&1
