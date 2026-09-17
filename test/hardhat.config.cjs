// Local chain for test/local-e2e.mjs only. LOCAL_CHAIN_ID selects Arc Testnet (5042002) or Arc Mainnet (5042) chain ids.
// Hardhat is used purely as a node; contracts are compiled by scripts/compile.mjs, so sources point at an empty folder.
module.exports = {
  solidity: '0.8.28',
  paths: { sources: './.hardhat/sources', cache: './.hardhat/cache', artifacts: './.hardhat/artifacts' },
  networks: {
    hardhat: {
      chainId: Number(process.env.LOCAL_CHAIN_ID || 5042002),
      initialBaseFeePerGas: 20_000_000_000, // Arc's observed base fee
      mining: { auto: true, interval: 1000 },
    },
  },
};
