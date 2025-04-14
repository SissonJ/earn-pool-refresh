#!/bin/bash

cd /root/dao-earn-manager
ts-node --esm ./index.ts >> ./logs/"$(date +%Y-%m).log" 2>&1
