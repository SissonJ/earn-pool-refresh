import { config } from 'dotenv';
import {
  MsgExecuteContract,
  SecretNetworkClient,
  Wallet, 
} from 'secretjs';
import * as fs from 'fs';

type Results = {
  queryLength: number[],
  start?: number,
  lastUpdate?: number,
  successfulTxs: number,
  failedTxs: number,
  failedQueries: number,
}

type BatchQueryResponse = {
  batch: {
    block_height: number,
    responses: {
      id: string,
      contract: {
        address: string,
        code_hash: string,
      },
      response: {
        response: string,
      },
    }[],
  },
}

config();

if(!process.env.NODE 
   || !process.env.CHAIN_ID
   || !process.env.PRIVATE_KEY
   || !process.env.WALLET_ADDRESS
   || !process.env.BATCH_QUERY_CONTRACT
   || !process.env.STABILITY_POOL_ADDRESS
   || !process.env.SHADE_LEND_PERMIT
   || !process.env.MONEY_MARKET_ADDRESS
   || !process.env.SHADE_MASTER_PERMIT
   || !process.env.SILK_TOKEN_ADDRESS
  ) {
  throw new Error('Missing env variables are required in the .env file');
}

// Alows you to easly decrypt transacitons later
const encryptionSeed = process.env.ENCRYPTION_SEED 
  ? Uint8Array.from(process.env.ENCRYPTION_SEED!.split(',').map(Number)) 
  : undefined;

const client = new SecretNetworkClient({
  url: process.env.NODE!,
  chainId: process.env.CHAIN_ID!,
  wallet: new Wallet(process.env.PRIVATE_KEY!),
  walletAddress: process.env.WALLET_ADDRESS!,
  encryptionSeed,
});

const encodeJsonToB64 = (toEncode:any) : string => Buffer.from(
  JSON.stringify(toEncode), 'utf8'
).toString('base64');

const decodeB64ToJson = (encodedData: string) => JSON.parse(
  Buffer.from(encodedData, 'base64').toString('utf8')
);

const getCentralTime = (date: Date): string => {
  return date.toLocaleString(
    'en-US', 
    {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  ).replace(
    /(\d+)\/(\d+)\/(\d+)/, 
    '$3-$1-$2'
  );
};

const logger = {
  error: (msg: string, time: Date, error?: any) => {
    console.error(`[${getCentralTime(time)} ERROR] ${msg}`, error);
  },
  info: (msg: string, time: Date) => {
    console.log(`[${getCentralTime(time)} INFO] ${msg}`);
  }
};

async function main() {
  if (!fs.existsSync(`./repayerResults.txt`)) {
    const initialState: Results = { 
      queryLength: [], 
      successfulTxs: 0,
      failedTxs: 0,
      failedQueries: 0,
    };
    fs.writeFileSync(`./repayerResults.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./repayerResults.txt`, 'utf-8');
  const results: Results = JSON.parse(resultsUnparsed);

  const now = new Date();

  if (results.start === undefined ||  now.getTime() - (results.lastUpdate ?? 0) > 3_600_000 * 2) {
    if(results.start === undefined) {
      results.start = now.getTime();
    }
    if(results.queryLength === undefined) {
      results.queryLength = [];
    }
    const queryLength = results.queryLength.reduce(
      (acc, curr) => acc + curr, 
      0
    ) / results.queryLength.length;
    results.lastUpdate = now.getTime();
    logger.info(
      `Bot running for ${Math.floor((now.getTime() - results.start) / 3_600_000)} hours` +
      `  Successful: ${results.successfulTxs}` +
      `  Failed: ${results.failedTxs}` +
      `  Queries Failed: ${results.failedQueries} ` +
      `  Average Query Length: ${queryLength.toFixed(3)}`,
      now
    );
    results.failedQueries = 0; // reset query errors after logging
  }

  const queryMsg = {
    batch: {
      queries: [{
        id: encodeJsonToB64('stabilityPool'),
        contract: {
          address: process.env.STABILITY_POOL_ADDRESS!,
          code_hash: process.env.STABILITY_POOL_CODE_HASH,
        },
        query: encodeJsonToB64({ 
          with_permit: {
            permit: JSON.parse(
              process.env.SHADE_LEND_PERMIT!,
            ),
            query: { get_user_data: {} },
          },
        }),
      },
      {
        id: encodeJsonToB64('moneyMarket'),
        contract: {
          address: process.env.MONEY_MARKET_ADDRESS!,
          code_hash: process.env.MONEY_MARKET_CODE_HASH,
        },
        query: encodeJsonToB64({ 
          user_position: { 
            authentication: { 
              permit: JSON.parse(
                process.env.SHADE_MASTER_PERMIT!
              ) 
            } 
          } 
        }),
      }] as any[],
    }
  };

  const beforeQuery = new Date().getTime();
  let queryResponse;
  try {
    queryResponse = await client.query.compute.queryContract({
      contract_address: process.env.BATCH_QUERY_CONTRACT!,
      code_hash: process.env.BATCH_QUERY_HASH,
      query: queryMsg,
    }) as BatchQueryResponse;
  } catch (e: any)  {
    fs.writeFileSync('./repayerResults.txt', JSON.stringify(results, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }
  if(queryResponse === undefined || queryResponse === null) {
    results.failedQueries += 1;
    fs.writeFileSync('./repayerResults.txt', JSON.stringify(results, null, 2));
    return;
  }
  const queryLength = (new Date().getTime() - beforeQuery) / 1000;
  results.queryLength.push(queryLength);
  if(results.queryLength.length > 100) {
    // Keep the last 10 query lengths for average calculation
    results.queryLength.shift();
  }

  let totalSilkDebt = 0;
  let silkInStabilityPool = 0;
  let claimableRewards = 0;
  queryResponse.batch.responses.forEach((query) => {
    const queryData = decodeB64ToJson(query.response.response);
    const queryKey = decodeB64ToJson(query.id);
    if(queryKey === 'stabilityPool') {
      silkInStabilityPool = queryData.user_data.remaining_silk;
      claimableRewards = queryData.user_data.claimable_rewards.reduce((
        prev: number, 
        curr: number[]
      ) => {
        if(Number(curr[1]) > 0) {
          return prev + 1;
        }
        return prev;
      }, 0);
    }
    if(queryKey === 'moneyMarket') {
      const silkDebt = queryData.debt.find(
        (nextDebt: any) => nextDebt.token === process.env.SILK_TOKEN_ADDRESS!
      );
      if(silkDebt !== undefined) {
        totalSilkDebt = Number(silkDebt.principal) + Number(silkDebt.interest_accrued);
      }
    }
  });

  // If tx threshold is not met
  if(totalSilkDebt === 0 
    || silkInStabilityPool < totalSilkDebt 
    || claimableRewards > 1
  ) {
    fs.writeFileSync('./repayerResults.txt', JSON.stringify(results, null, 2));
    return;
  }

  const msgs: MsgExecuteContract<any>[] = [
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: process.env.STABILITY_POOL_ADDRESS!,
      code_hash: process.env.STABILITY_POOL_CODE_HASH!,
      msg: { user: { withdraw_silk: totalSilkDebt.toFixed(0), } }, 
      sent_funds: [],
    }),
    new MsgExecuteContract({ 
      sender: client.address, 
      contract_address: process.env.SILK_TOKEN_ADDRESS!,
      code_hash: process.env.SILK_TOKEN_CODE_HASH!,
      msg: {
        send: {
          recipient: process.env.MONEY_MARKET_ADDRESS!,
          recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
          amount: totalSilkDebt.toFixed(0),
          msg: encodeJsonToB64({ repay:{} })
        }
      }, 
      sent_funds: [],
    })
  ];

  const executeResponse = await client.tx.broadcast(
    msgs,
    {
      gasLimit: 1_000_000,
      feeDenom: 'uscrt',
    },
  )
  if(executeResponse?.transactionHash !== undefined) {
    fs.appendFile('../transactions.txt', 
      `${now.getTime()},${executeResponse.transactionHash},debtRepayer\n`, 
      (err) => {
        if (err) logger.error('Failed to append transaction hash', now, err);
      }
    );
  }
  if(executeResponse.code === 0) {
    logger.info(`ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.jsonLog, null, 2), now);
    results.successfulTxs += 1;
  } else {
    logger.info(`ATTEMPT FAILED - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.rawLog), now);
    results.failedTxs += 1;
  }

  fs.writeFileSync('./repayerResults.txt', JSON.stringify(results, null, 2));
}

main().catch((error:any) => { logger.error(error?.message, new Date());});
