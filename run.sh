#!/bin/bash

cd /root/earn-pool-refresh
ts-node --esm ./index.ts >> ./logs/"$(date +%Y-%m).log" 2>&1
