// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D20VRFConsumer} from "@d20dao/vrf-sdk/contracts/D20VRFConsumer.sol";
import {ID20VRF} from "@d20dao/vrf-sdk/contracts/interfaces/ID20VRF.sol";
import {D20VRFRequests} from "@d20dao/vrf-sdk/contracts/libraries/D20VRFRequests.sol";
import {RandomnessMapping as M} from "@d20dao/vrf-sdk/contracts/libraries/RandomnessMapping.sol";

/// @dev Coordinator read that is in the SDK's coordinatorAbi but not in the minimal ID20VRF interface.
interface ID20VRFMappingReader {
    function getMapping(uint256 requestId) external view returns (M.Spec memory);
}

/// @title D20Playground
/// @notice Demo consumer with one entry point per D20DAO randomness option (raw word, d20/d12/d10/d8/d6/d4, dN, dice roll,
///         coin flip, number range, choose one, choose many, shuffle). It keeps the latest fulfilled result for every option
///         and the last HISTORY_SIZE fulfilled results on-chain, readable by anyone.
/// @dev Payment: the caller sends msg.value quoted off-chain (quoteRequestFee: quoteFeeAt at the latest base fee + buffer).
///      quoteFee(CALLBACK_GAS) is exact inside this transaction; the SDK's D20VRFRequests helper pays exactly that from this
///      contract's balance (funded by msg.value) and the change is returned. The caller is the fixed refund address.
///
///      Storage of results: the callback runs on a fixed gas budget (CALLBACK_GAS) chosen at request time, and a shuffle can
///      have 256 values (~5.6M gas to store as uint256s, above the coordinator's 1,000,000 MAX_CALLBACK_GAS). So the
///      callback stores a fixed-size record: the raw word, fulfilment block/time, and the request's mapping spec copied at
///      request time from coordinator.getMapping. The read functions return the mapped values by running the SDK's
///      RandomnessMapping.map over that stored word and spec - the same library and inputs the coordinator's
///      getMappedResult uses - so they are fully determined by this contract's storage.
contract D20Playground is D20VRFConsumer {
    using D20VRFRequests for ID20VRF;

    enum Kind { Raw, D20, D12, D10, D8, D6, D4, DN, DiceRoll, CoinFlip, NumberRange, ChooseOne, ChooseMany, Shuffle }
    enum Status { Unknown, Pending, Fulfilled, Refunded }

    struct Job {
        // slot 0
        address requester;
        Kind kind;
        Status status;
        uint40 requestedAt;
        uint40 fulfilledAt;
        // slot 1
        uint64 requestBlock;
        uint64 fulfilledBlock;
        M.Operation operation;
        uint32 count;
        uint32 population;
        // slots 2-5
        uint256 lower;
        uint256 upper;
        bytes32 context;
        bytes32 word;
    }

    /// @notice Everything needed to display one request. `mappedValues` is empty unless status == Fulfilled.
    struct Result {
        uint256 requestId;      // 0 = no result
        address requester;
        Kind kind;
        Status status;
        uint64 requestedAt;     // unix seconds
        uint64 requestBlock;
        uint64 fulfilledAt;     // unix seconds (callback time)
        uint64 fulfilledBlock;
        bytes32 context;        // caller label, or keccak256(abi.encode(items)) for choose/shuffle
        bytes32 word;           // raw word delivered by the coordinator
        M.Spec spec;            // mapping stored by the coordinator for this request
        uint256[] mappedValues; // RandomnessMapping.map(word, spec)
    }

    /// @notice Callback gas forwarded by the coordinator. Worst case (all first-time storage writes) is measured by
    ///         `npm run test:local` and `npm run simulate`; see README.
    uint32 public constant CALLBACK_GAS = 150_000;
    uint8 public constant KIND_COUNT = 14;
    uint8 public constant HISTORY_SIZE = 20;

    ID20VRF public immutable rng;
    uint256 public requestCount;
    uint256 public fulfilledCount;
    mapping(uint256 => Job) private jobs;
    mapping(address => uint256[]) private jobIdsByRequester;
    uint256[KIND_COUNT] private latestIdByKind;
    uint256[HISTORY_SIZE] private recentIds; // ring buffer; newest at (fulfilledCount - 1) % HISTORY_SIZE

    event JobRequested(uint256 indexed requestId, address indexed requester, Kind indexed kind, bytes32 context, uint256 feePaid);
    /// @notice The exact ordered list a choose/shuffle request committed to; keccak256(abi.encode(items)) == itemsHash.
    event ItemsCommitted(uint256 indexed requestId, bytes32 indexed itemsHash, string[] items);
    event JobFulfilled(uint256 indexed requestId, address indexed requester, Kind indexed kind, bytes32 word);
    event JobRefunded(uint256 indexed requestId);

    error FeeBelowQuote(uint256 quote, uint256 sent);
    error UnexpectedCallback(uint256 requestId);
    error ChangeTransferFailed();

    constructor(address coordinator) D20VRFConsumer(coordinator) {
        rng = ID20VRF(coordinator);
    }

    // ------------------------------------------------------------------ requests

    /// @notice Raw 256-bit word (requestRandomness; the coordinator stores the Raw mapping).
    function requestRaw(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.Raw, context);
        id = rng.requestRandomness{value: fee}(seed, CALLBACK_GAS, msg.sender);
        _record(id, Kind.Raw, context, fee);
        _returnChange(fee);
    }

    function rollD20(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D20, context);
        id = rng.d20(_options(seed));
        _record(id, Kind.D20, context, fee);
        _returnChange(fee);
    }

    function rollD12(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D12, context);
        id = rng.d12(_options(seed));
        _record(id, Kind.D12, context, fee);
        _returnChange(fee);
    }

    function rollD10(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D10, context);
        id = rng.d10(_options(seed));
        _record(id, Kind.D10, context, fee);
        _returnChange(fee);
    }

    function rollD8(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D8, context);
        id = rng.d8(_options(seed));
        _record(id, Kind.D8, context, fee);
        _returnChange(fee);
    }

    function rollD6(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D6, context);
        id = rng.d6(_options(seed));
        _record(id, Kind.D6, context, fee);
        _returnChange(fee);
    }

    function rollD4(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.D4, context);
        id = rng.d4(_options(seed));
        _record(id, Kind.D4, context, fee);
        _returnChange(fee);
    }

    /// @notice One die with `sides` faces (>= 2). Result 1..sides.
    function rollDN(uint256 sides, bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.DN, context);
        id = rng.dN(sides, _options(seed));
        _record(id, Kind.DN, context, fee);
        _returnChange(fee);
    }

    /// @notice `count` dice (1..128) with `sides` faces (>= 2) each. Repeats allowed.
    function rollDice(uint256 sides, uint32 count, bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.DiceRoll, context);
        id = rng.diceRoll(sides, count, _options(seed));
        _record(id, Kind.DiceRoll, context, fee);
        _returnChange(fee);
    }

    /// @notice 0 = tails, 1 = heads.
    function flipCoin(bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.CoinFlip, context);
        id = rng.coinFlip(_options(seed));
        _record(id, Kind.CoinFlip, context, fee);
        _returnChange(fee);
    }

    /// @notice One value in [min, max] inclusive (min <= max).
    function randomInRange(uint256 min, uint256 max, bytes32 context) external payable returns (uint256 id) {
        (uint256 fee, bytes32 seed) = _begin(Kind.NumberRange, context);
        id = rng.numberRange(min, max, _options(seed));
        _record(id, Kind.NumberRange, context, fee);
        _returnChange(fee);
    }

    /// @notice One zero-based index into `items` (1..256 items). The list is hashed and bound into the seed before the
    ///         request and emitted in ItemsCommitted, so any viewer can map the index back to the committed item.
    function chooseOne(string[] calldata items) external payable returns (uint256 id) {
        bytes32 itemsHash = keccak256(abi.encode(items));
        (uint256 fee, bytes32 seed) = _begin(Kind.ChooseOne, itemsHash);
        id = rng.chooseOne(uint32(items.length), _options(seed));
        _record(id, Kind.ChooseOne, itemsHash, fee);
        emit ItemsCommitted(id, itemsHash, items);
        _returnChange(fee);
    }

    /// @notice `count` distinct zero-based indices into `items` (1 <= count <= items.length <= 256).
    function chooseMany(string[] calldata items, uint32 count) external payable returns (uint256 id) {
        bytes32 itemsHash = keccak256(abi.encode(items));
        (uint256 fee, bytes32 seed) = _begin(Kind.ChooseMany, itemsHash);
        id = rng.chooseMany(uint32(items.length), count, _options(seed));
        _record(id, Kind.ChooseMany, itemsHash, fee);
        emit ItemsCommitted(id, itemsHash, items);
        _returnChange(fee);
    }

    /// @notice Full permutation of the indices of `items` (1..256 items).
    function shuffle(string[] calldata items) external payable returns (uint256 id) {
        bytes32 itemsHash = keccak256(abi.encode(items));
        (uint256 fee, bytes32 seed) = _begin(Kind.Shuffle, itemsHash);
        id = rng.shuffle(uint32(items.length), _options(seed));
        _record(id, Kind.Shuffle, itemsHash, fee);
        emit ItemsCommitted(id, itemsHash, items);
        _returnChange(fee);
    }

    // ------------------------------------------------------------------ reads

    /// @notice Full record of one request made through this contract (requestId 0 in the result = unknown request).
    function getResult(uint256 requestId) public view returns (Result memory result) {
        Job storage job = jobs[requestId];
        if (job.status == Status.Unknown) return result;
        result.requestId = requestId;
        result.requester = job.requester;
        result.kind = job.kind;
        result.status = job.status;
        result.requestedAt = job.requestedAt;
        result.requestBlock = job.requestBlock;
        result.fulfilledAt = job.fulfilledAt;
        result.fulfilledBlock = job.fulfilledBlock;
        result.context = job.context;
        result.word = job.word;
        result.spec = M.Spec(job.operation, job.lower, job.upper, job.count, job.population);
        if (job.status == Status.Fulfilled) result.mappedValues = M.map(job.word, result.spec);
    }

    /// @notice Most recent fulfilled result for one option.
    function latestResult(Kind kind) external view returns (Result memory) {
        return getResult(latestIdByKind[uint8(kind)]);
    }

    /// @notice Most recent fulfilled result for every option, indexed by Kind (requestId 0 = none yet).
    function latestResults() external view returns (Result[] memory results) {
        results = new Result[](KIND_COUNT);
        for (uint256 i; i < KIND_COUNT; ++i) results[i] = getResult(latestIdByKind[i]);
    }

    /// @notice Up to HISTORY_SIZE most recent fulfilled results across all options, newest first.
    function recentResults() external view returns (Result[] memory results) {
        uint256 total = fulfilledCount;
        uint256 n = total < HISTORY_SIZE ? total : HISTORY_SIZE;
        results = new Result[](n);
        for (uint256 i; i < n; ++i) results[i] = getResult(recentIds[(total - 1 - i) % HISTORY_SIZE]);
    }

    function jobIdsOf(address requester) external view returns (uint256[] memory) {
        return jobIdsByRequester[requester];
    }

    // ------------------------------------------------------------------ coordinator callbacks

    /// @dev Fixed-size writes only (independent of the mapping size), so CALLBACK_GAS covers every option.
    function _fulfillRandomness(uint256 requestId, bytes32 randomness) internal override {
        Job storage job = jobs[requestId];
        if (job.status != Status.Pending) revert UnexpectedCallback(requestId);
        job.status = Status.Fulfilled;
        job.fulfilledAt = uint40(block.timestamp);
        job.fulfilledBlock = uint64(block.number);
        job.word = randomness;
        Kind kind = job.kind;
        latestIdByKind[uint8(kind)] = requestId;
        uint256 total = fulfilledCount;
        recentIds[total % HISTORY_SIZE] = requestId;
        fulfilledCount = total + 1;
        emit JobFulfilled(requestId, job.requester, kind, randomness);
    }

    /// @dev The fee refund itself was already pushed (or credited) to the requester, the fixed refund address.
    function _onRefund(uint256 requestId) internal override {
        Job storage job = jobs[requestId];
        if (job.status != Status.Pending) revert UnexpectedCallback(requestId);
        job.status = Status.Refunded;
        emit JobRefunded(requestId);
    }

    // ------------------------------------------------------------------ internals

    function _begin(Kind kind, bytes32 context) private returns (uint256 fee, bytes32 seed) {
        // Exact inside the requesting transaction (block.basefee of this transaction).
        fee = rng.quoteFee(CALLBACK_GAS);
        if (msg.value < fee) revert FeeBelowQuote(fee, msg.value);
        uint256 nonce = ++requestCount;
        seed = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce, kind, context));
    }

    function _options(bytes32 seed) private view returns (D20VRFRequests.Options memory) {
        return D20VRFRequests.Options({clientSeed: seed, callbackGasLimit: CALLBACK_GAS, refundAddress: msg.sender});
    }

    function _record(uint256 id, Kind kind, bytes32 context, uint256 fee) private {
        Job storage job = jobs[id];
        if (job.status != Status.Unknown) revert UnexpectedCallback(id);
        // Copy the mapping exactly as the coordinator stored it, so read functions reproduce getMappedResult.
        M.Spec memory spec = ID20VRFMappingReader(address(rng)).getMapping(id);
        job.requester = msg.sender;
        job.kind = kind;
        job.status = Status.Pending;
        job.requestedAt = uint40(block.timestamp);
        job.requestBlock = uint64(block.number);
        job.operation = spec.operation;
        job.count = spec.count;
        job.population = spec.population;
        job.lower = spec.lower;
        job.upper = spec.upper;
        job.context = context;
        jobIdsByRequester[msg.sender].push(id);
        emit JobRequested(id, msg.sender, kind, context, fee);
    }

    /// @dev Last step of every request (after all state and events), returning msg.value above the exact fee.
    function _returnChange(uint256 fee) private {
        uint256 change = msg.value - fee;
        if (change != 0) {
            (bool ok,) = msg.sender.call{value: change}("");
            if (!ok) revert ChangeTransferFailed();
        }
    }
}
