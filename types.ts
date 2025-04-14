export type Results = {
  silkAmount: number,
  stabilityPoolAmount: number,
  start?: number,
  lastUpdate?: number,
  lastFailed?: number,
  queryLength: number[],
  profit: number,
  failedTxs: number,
  failedQueries: number,
  successfulTxs: number,
}

export type StabilityPoolResponse = {
  user_data: {
    reward_info: {
      assets: Array<{
        contract: {
          address: string,
          code_hash: string,
        },
        decimals: number,
        quote_symbol: string,
      }>,
      bond_amount: string,
      bond_scaling: string,
      epoch: string,
    },
    claimable_rewards: Array<[
      {
        contract: {
          address: string,
          code_hash: string,
        },
        decimals: number,
        quote_symbol: string,
      },
      string
    ]>,
    remaining_silk: string,
  },
};

export interface GraphQLResponse<T> {
  data?: T,
  errors?: Array<{
    message: string,
    locations: Array<{
      line: number,
      column: number,
    }>,
    extensions?: {
      code: string,
    },
  }>,
}

export type PoolsQueryResponse = {
  pools: Array<{
    id: string,
    contractAddress: string,
    codeHash: string,
    lpTokenId: string,
    lpTokenAmount: string,
    token0Id: string,
    token0Amount: string,
    token1Id: string,
    token1Amount: string,
    daoFee: string,
    lpFee: string,
    poolApr: string,
    stakingContractAddress: string,
    stakingContractCodeHash: string,
    stakedLpTokenAmount: string,
    flags: string,
    isEnabled: boolean,
    liquidityUsd: string,
    volumeUsd: string,
    volumeChangePercent: string,
    StableParams: {
      id: string,
      priceRatio: string,
      alpha: string,
      gamma1: string,
      gamma2: string,
      minTradeSize0For1: string,
      minTradeSize1For0: string,
      maxPriceImpact: string,
    },
    PoolToken: {
      rewardPerSecond: string,
      expirationDate: string,
      tokenId: string,
    },
  }>,
}

type TokenConfig = {
  tokenContractAddress: string,
  decimals: number,
}

type TokensConfig = TokenConfig[]

type Contract = {
  address: string,
  codeHash: string,
};

type CustomIterationControls = {
  epsilon: string,
  maxIteratorNewton: number,
  maxIteratorBisect: number,
}

type StableTokenData = {
  oracleKey: string,
  decimals: number,
}

type StableParams = {
  priceRatio: string | null,
  alpha: string,
  gamma1: string,
  gamma2: string,
  oracle: Contract,
  token0Data: StableTokenData,
  token1Data: StableTokenData,
  minTradeSizeXForY: string,
  minTradeSizeYForX: string,
  maxPriceImpactAllowed: string,
  customIterationControls: CustomIterationControls | null,
}

type PairInfo = {
  lpTokenAmount: string,
  lpTokenContract: Contract,
  token0Contract: Contract,
  token1Contract: Contract,
  factoryContract: Contract | null,
  daoContractAddress: string,
  isStable: boolean,
  token0Amount: string,
  token1Amount: string,
  lpFee: number,
  daoFee: number,
  stableParams: StableParams | null,
  contractVersion: number,
}

type BatchPairInfo = {
  pairContractAddress: string,
  pairInfo: PairInfo,
  blockHeight: number,
}

type BatchPairsInfo = BatchPairInfo[]

export type RoutesPoolData = {
  pairs: BatchPairsInfo,
  tokens: TokensConfig,
}

export type TokensQueryResponse = {
  tokens: Array<{
      id: string, 
      contractAddress: string, 
      symbol: string,
      Asset: {decimals: number}, 
      PriceToken: {priceId: string}[],
  }>,
}
