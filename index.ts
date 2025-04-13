import { config } from 'dotenv';
import {
 MsgExecuteContract, 
 SecretNetworkClient, 
 Wallet
} from 'secretjs';
import * as fs from 'fs';
import {
  GraphQLResponse,
 PoolsQueryResponse,
 Results, 
 RoutesPoolData, 
 StabilityPoolResponse, 
 TokensQueryResponse
} from './types';
import {
 BatchPairsInfo, 
 encodeJsonToB64, 
 getRoutes, 
} from '@shadeprotocol/shadejs';
import BigNumber from 'bignumber.js';

config();

if(!process.env.NODE 
   || !process.env.CHAIN_ID
   || !process.env.PRIVATE_KEY
   || !process.env.WALLET_ADDRESS
   || !process.env.STABILITY_POOL_ADDRESS
   || !process.env.SHADE_LEND_PERMIT
   || !process.env.GRAPHQL
   || !process.env.SILK_TOKEN_ADDRESS
   || !process.env.ROUTER_ADDRESS
   || !process.env.SILK_VIEWING_KEY
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

function mapGQLResponseToTarget(
  poolsResponse: PoolsQueryResponse, 
  tokensResponse: TokensQueryResponse
): RoutesPoolData {
  const pairs = poolsResponse.pools.map(pool => {
    const token0 = tokensResponse.tokens.find(token => token.id === pool.token0Id);
    const token1 = tokensResponse.tokens.find(token => token.id === pool.token1Id);
    return {
      pairContractAddress: pool.contractAddress,
      pairInfo: {
        lpTokenAmount: pool.lpTokenAmount,
        lpTokenContract: {
          address: pool.lpTokenId,
          codeHash: pool.codeHash,
        },
        token0Contract: { address: token0?.contractAddress, },
        token1Contract: { address: token1?.contractAddress, },
        isStable: pool.StableParams !== null,
        token0Amount: pool.token0Amount,
        token1Amount: pool.token1Amount,
        lpFee: parseFloat(pool.lpFee),
        daoFee: parseFloat(pool.daoFee),
        stableParams: pool.StableParams ? {
          priceRatio: pool.StableParams.priceRatio,
          alpha: pool.StableParams.alpha,
          gamma1: pool.StableParams.gamma1,
          gamma2: pool.StableParams.gamma2,
          minTradeSizeXForY: pool.StableParams.minTradeSize0For1,
          minTradeSizeYForX: pool.StableParams.minTradeSize1For0,
          maxPriceImpactAllowed: pool.StableParams.maxPriceImpact,
        } : null,
      },
    }
  }) as BatchPairsInfo;

  // Create tokens configuration using the tokens response
  const tokens = tokensResponse.tokens.map(token => ({
    tokenContractAddress: token.contractAddress,
    decimals: token.Asset.decimals,
  }));

  return {
    pairs,
    tokens,
  };
}

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
  if (!fs.existsSync(`./results.txt`)) {
    const initialState: Results = { 
      silkAmount: 0,
      queryLength: [], 
      successfulTxs: 0,
      failedTxs: 0,
      failedQueries: 0,
      profit: 0,
    };
    fs.writeFileSync(`./results.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./results.txt`, 'utf-8');
  const results: Results = JSON.parse(resultsUnparsed);

  const now = new Date();

 if (results.start === undefined ||  now.getTime() - (results.lastUpdate ?? 0) > 3_600_000 * 2) {
    if(results.start === undefined) {
      results.start = now.getTime();
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
      `  Running Profit: ${results.profit} ` +
      `  Average Query Length: ${queryLength.toFixed(3)}`,
      now
    );
    results.failedQueries = 0; // reset query errors after logging
  }

  const beforeQuery = new Date().getTime();
  let stabilityPoolQuery;
  try {
    stabilityPoolQuery = await client.query.compute.queryContract<any, StabilityPoolResponse>({
      contract_address: process.env.STABILITY_POOL_ADDRESS!,
      code_hash: process.env.STABILITY_POOL_CODE_HASH,
      query: { 
        with_permit: {
          permit: JSON.parse(
            process.env.SHADE_LEND_PERMIT!,
          ),
          query: { get_user_data: {} },
        },
      }, 
    });
  } catch (e:any) {
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }
  if(!stabilityPoolQuery?.user_data) {
    throw new Error('No user data found');
  }
  const queryLength = (new Date().getTime() - beforeQuery) / 1000;
  results.queryLength.push(queryLength);
  if(results.queryLength.length > 100) {
    // Keep the last 10 query lengths for average calculation
    results.queryLength.shift();
  }
  const claimableRewards = stabilityPoolQuery.user_data.claimable_rewards.filter((reward) => {
    return reward[1] !== '0';
  });

  // 2 because SHD will always be present
  if(claimableRewards.length < 2) {
    results.silkAmount = Number(stabilityPoolQuery.user_data.remaining_silk);
    fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
    return;
  }

  let executeResponse;
  try {
    logger.info(`ATTEMPTING - CLAIM`, now);
    executeResponse = await client.tx.broadcast([new MsgExecuteContract({
          sender: client.address, 
          contract_address: process.env.STABILITY_POOL_ADDRESS!,
          code_hash: process.env.STABILITY_POOL_CODE_HASH!,
          msg: { user:{ claim_rewards: {} } }, 
          sent_funds: [],
      })],
      {
        gasLimit: 450_000, // Enough for 3
        feeDenom: 'uscrt',
      },
    )
  } catch (e) {
    throw new Error('Error executing claim transaction');
  }
  if(executeResponse?.transactionHash !== undefined) {
    fs.appendFile('../transactions.txt', 
      `${now.getTime()},${executeResponse.transactionHash},earnClaim\n`, 
      (err) => {
        if (err) logger.error('Failed to append transaction hash', now, err);
      }
    );
  }
  if(executeResponse.code === 0) {
    logger.info(`ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.jsonLog, null, 2), now);
  } else {
    logger.info(`ATTEMPT FAILED - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.rawLog), now);
    results.failedTxs += 1;
    results.lastFailed = now.getTime();
    return;
  }

  let query = `
    query Pools {
      pools(query: {}) {
        id
        contractAddress
        codeHash
        lpTokenId
        lpTokenAmount
        token0Id
        token0Amount
        token1Id
        token1Amount
        daoFee
        lpFee
        poolApr
        stakingContractAddress
        stakingContractCodeHash
        stakedLpTokenAmount
        flags
        isEnabled
        liquidityUsd
        volumeUsd
        volumeChangePercent
        StableParams {
          id
          priceRatio
          alpha
          gamma1
          gamma2
          minTradeSize0For1
          minTradeSize1For0
          maxPriceImpact
        }
        PoolToken {
          rewardPerSecond
          expirationDate
          tokenId
        } 
      }
    }
  `;
  const poolsRaw = await fetch(process.env.GRAPHQL!, {
    method: "POST",
    headers: { "Content-Type": "application/json", },
    body: JSON.stringify({ query, })
  });
  const poolsBody: GraphQLResponse<PoolsQueryResponse> = await poolsRaw.json();
  if (poolsBody.errors || poolsBody.data == undefined) {
    results.failedQueries += 1;
    fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
    return;
  }
  query = `
    query Tokens {
      tokens(query: {
        where: {
          flags: {
            has: SNIP20
          }
        }
      }) {
        id
        contractAddress
        symbol
        Asset {
          decimals
        }
        PriceToken{
          priceId
        }
      }
    }
  `;

  const gqlTokenResp = await fetch(process.env.GRAPHQL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", },
      body: JSON.stringify({ query, })
  });
  const tokenBody: GraphQLResponse<TokensQueryResponse> = await gqlTokenResp.json();
  if (tokenBody.errors || tokenBody.data == undefined) {
    results.failedQueries += 1;
    fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
    return;
  }
  const formmattedPoolsAndTokens = mapGQLResponseToTarget(poolsBody.data, tokenBody.data);
  for(const reward of claimableRewards) {
    const routes = getRoutes({
      inputTokenAmount: BigNumber(reward[1]),
      inputTokenContractAddress: reward[0].contract.address,
      outputTokenContractAddress: process.env.SILK_TOKEN_ADDRESS!,
      maxHops: 3,
      pairs: formmattedPoolsAndTokens.pairs,
      tokens: formmattedPoolsAndTokens.tokens,
    });
    const sortedRoutes = routes.sort((a, b) => 
      b.quoteOutputAmount.comparedTo(a.quoteOutputAmount) ?? 0
    );
    if(sortedRoutes.length === 0) {
      continue;
    }
    let gasMultiplier = 0;
    console.log(sortedRoutes[0]);
    const path = sortedRoutes[0].path.map((route) => {
      const nextPool: any = poolsBody?.data?.pools.find(
        (poolAddress) => poolAddress.contractAddress === route
      );
      if (nextPool?.flags.includes('derivative') || nextPool?.flags.includes('STABLE')) {
        gasMultiplier += 2.7;
      }  else {
        gasMultiplier += 1;
      }
      return {
        addr: nextPool?.contractAddress,
        code_hash: nextPool?.codeHash,
      }
    });

    let swapExecuteResponse;
    try {
      const msg = {
        send: {
          recipient: process.env.ROUTER_ADDRESS!,
          recipient_code_hash: process.env.ROUTER_CODE_HASH!,
          amount: reward[1],
          msg: encodeJsonToB64({
            swap_tokens_for_exact:{
              expected_return: sortedRoutes[0].quoteOutputAmount.times(0.95).toFixed(0),
              path,
            }
          }),
        }
      }
      swapExecuteResponse = await client.tx.broadcast([new MsgExecuteContract({
          sender: client.address, 
          contract_address: reward[0].contract.address,
          code_hash: reward[0].contract.code_hash,
          msg: msg, 
          sent_funds: [],
      })],
        {
          gasLimit: (750_000 * gasMultiplier),
          feeDenom: 'uscrt',
        },
      )
    } catch (e: any) {
      logger.error('Error executing swap transaction', now, e?.message);
    }
    if(swapExecuteResponse?.transactionHash !== undefined) {
      fs.appendFile('../transactions.txt', 
        `${now.getTime()},${swapExecuteResponse.transactionHash},earnSwap\n`, 
        (err) => {
          if (err) logger.error('Failed to append transaction hash', now, err);
        }
      );
    }
    if(swapExecuteResponse !== undefined && swapExecuteResponse.code === 0) {
      logger.info(`SWAP ATTEMPT SUCCESSFUL - ${swapExecuteResponse.transactionHash}`, now);
    } else {
      logger.info(`SWAP ATTEMPT FAILED - ${swapExecuteResponse?.transactionHash}`, now);
      logger.info(JSON.stringify(swapExecuteResponse?.rawLog), now);
    }
  }

  let balance;
  let retry = 0;
  while(balance === undefined && retry < 5) {
    try {
      balance = await client.query.snip20.getBalance({
        contract: {
          address: process.env.SILK_TOKEN_ADDRESS!,
          code_hash: process.env.SILK_TOKEN_CODE_HASH!,
        },
        address: client.address,
        auth: { key: process.env.SILK_VIEWING_KEY! }
      });
    } catch (e:any) {
      if(e.message.includes('invalid json response')) {
        results.failedQueries += 1;
      }
    }
    balance = balance?.balance?.amount;
    retry++;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if(balance === undefined) {
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    throw new Error('Silk balance undefined');
  }

  const depositExecuteResponse = await client.tx.broadcast([new MsgExecuteContract({ 
      sender: client.address, 
      contract_address: process.env.SILK_TOKEN_ADDRESS!,
      code_hash: process.env.SILK_TOKEN_CODE_HASH!,
      msg: {
        send: {
          recipient: process.env.STABILITY_POOL_ADDRESS,
          recipient_code_hash: process.env.STABILITY_POOL_CODE_HASH,
          amount: balance,
          msg: encodeJsonToB64({ deposit_silk:{} })
        }
      }, 
      sent_funds: [],
    })],
    {
      gasLimit: 500_000,
      feeDenom: 'uscrt',
    },
  )
  const profit = ((Number(stabilityPoolQuery.user_data.remaining_silk) + Number(balance)) 
    - results.silkAmount) / 10**6;
  results.profit += profit;
  if(depositExecuteResponse?.transactionHash !== undefined) {
    fs.appendFile('../transactions.txt', 
      `${now.getTime()},${depositExecuteResponse.transactionHash},earnDeposit,${profit}\n`, 
      (err) => {
        if (err) logger.error('Failed to append transaction hash', now, err);
      }
    );
  }
  if(depositExecuteResponse.code === 0) {
    logger.info(
      `DEPOSIT ATTEMPT SUCCESSFUL - ${depositExecuteResponse.transactionHash}, 
      ${profit} silk made`, 
      now
    );
    logger.info(JSON.stringify(depositExecuteResponse.jsonLog, null, 2), now);
    results.successfulTxs += 1;
  } else {
    logger.info(`DEPOSIT ATTEMPT FAILED - ${depositExecuteResponse.transactionHash}`, now);
    logger.info(JSON.stringify(depositExecuteResponse.rawLog), now);
    results.failedTxs += 1;
    results.lastFailed = now.getTime();
  }

  results.silkAmount = Number(stabilityPoolQuery.user_data.remaining_silk) + Number(balance);
  fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
}

main().catch((error:any) => { logger.error(error?.message, new Date());});
