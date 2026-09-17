// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RandomnessMapping} from "@d20dao/vrf-sdk/contracts/libraries/RandomnessMapping.sol";
import {ID20VRFConsumer, ID20VRFRefundConsumer} from "@d20dao/vrf-sdk/contracts/interfaces/ID20VRF.sol";

/// @notice LOCAL TEST ONLY. Mirrors the parts of D20VRFCoordinator (protocol commit 640b60c) that D20Playground and the
///         page touch: same request checks, fee formula, 60 s deadline, exact callback gas with the same reserve check,
///         refund push + onRefund hook, retryCallback, refund credit, and the same public read functions and errors.
///         No VRF proof or epochs: a test "keeper" calls fulfill(id, word).
contract MockCoordinator {
    struct Request {
        address consumer; uint32 callbackGasLimit; uint64 requestBlock; uint64 targetBlock; uint64 deadline;
        address refundAddress; bytes32 clientSeed; bytes32 mappingHash; bytes32 blockHash; bytes32 randomness;
        bytes32 proofHash; bytes32 transcriptHash; bool fulfilled; bool delivered; bool refunded; uint64 epochId; bytes32 epochHash;
    }

    uint256 private lastId;
    mapping(uint256 => Request) private requests;
    mapping(uint256 => RandomnessMapping.Spec) private specs;
    mapping(uint256 => uint256) public requestFeePaid;
    mapping(address => uint256) public refundCredits;

    event CallbackAttempted(uint256 indexed requestId, bool success, uint32 gasLimit);
    event CallbackGasUsed(uint256 indexed requestId, uint256 gasUsed);
    event RequestRefundedTo(uint256 indexed requestId, address indexed refundAddress, uint256 amount, bool paid);

    error ContractConsumerRequired();
    error InvalidRefundAddress();
    error InvalidCallbackGas();
    error IncorrectFee(uint256 expected, uint256 actual);
    error UnknownRequest();
    error NotFulfilled();
    error AlreadyFulfilled();
    error AlreadyDelivered();
    error RequestExpired();
    error RequestRefunded();
    error RefundNotAvailable();
    error InsufficientCallbackGas();
    error NoRefundCredit();

    function pricing() external pure returns (uint256, uint16, uint32) { return (8e16, 5, 300_000); }
    function nextRequestId() external view returns (uint256) { return lastId + 1; }
    function quoteFeeAt(uint32 callbackGasLimit, uint256 baseFee) public pure returns (uint256) {
        uint256 dynamic = 5 * baseFee * (300_000 + uint256(callbackGasLimit));
        return dynamic > 8e16 ? dynamic : 8e16;
    }
    function quoteFee(uint32 callbackGasLimit) external view returns (uint256) { return quoteFeeAt(callbackGasLimit, block.basefee); }

    function requestRandomness(bytes32 clientSeed, uint32 callbackGasLimit, address refundAddress) external payable returns (uint256) {
        RandomnessMapping.Spec memory raw;
        return _create(clientSeed, callbackGasLimit, refundAddress, raw);
    }
    function requestMappedRandomness(bytes32 clientSeed, uint32 callbackGasLimit, address refundAddress, RandomnessMapping.Spec calldata spec)
        external payable returns (uint256)
    {
        return _create(clientSeed, callbackGasLimit, refundAddress, spec);
    }
    function _create(bytes32 clientSeed, uint32 callbackGasLimit, address refundAddress, RandomnessMapping.Spec memory spec)
        private returns (uint256 id)
    {
        if (msg.sender.code.length == 0) revert ContractConsumerRequired();
        if (refundAddress == address(0)) revert InvalidRefundAddress();
        if (callbackGasLimit < 30_000 || callbackGasLimit > 1_000_000) revert InvalidCallbackGas();
        uint256 fee = quoteFeeAt(callbackGasLimit, block.basefee);
        if (msg.value < fee) revert IncorrectFee(fee, msg.value);
        RandomnessMapping.validate(spec);
        id = ++lastId;
        Request storage r = requests[id];
        r.consumer = msg.sender; r.callbackGasLimit = callbackGasLimit; r.requestBlock = uint64(block.number);
        r.deadline = uint64(block.timestamp + 60); r.refundAddress = refundAddress; r.clientSeed = clientSeed;
        r.mappingHash = RandomnessMapping.hash(spec);
        specs[id] = spec;
        requestFeePaid[id] = fee;
        refundCredits[refundAddress] += msg.value - fee;
    }

    function pendingIds() external view returns (uint256[] memory ids) {
        ids = new uint256[](lastId);
        uint256 n;
        for (uint256 i = 1; i <= lastId; ++i) {
            Request storage r = requests[i];
            if (!r.fulfilled && !r.refunded && block.timestamp <= r.deadline) ids[n++] = i;
        }
        assembly { mstore(ids, n) }
    }

    /// @notice Test keeper: accept `word` for a live request and deliver it with the request's callback gas.
    function fulfill(uint256 id, bytes32 word) external { _fulfill(id, word, requests[id].callbackGasLimit); }

    /// @notice Test keeper that delivers with less gas than requested, to exercise callback failure + retryCallback.
    function fulfillWithDeliveryGas(uint256 id, bytes32 word, uint32 deliveryGas) external { _fulfill(id, word, deliveryGas); }

    function _fulfill(uint256 id, bytes32 word, uint32 deliveryGas) private {
        Request storage r = _request(id);
        if (r.fulfilled) revert AlreadyFulfilled();
        if (r.refunded) revert RequestRefunded();
        if (block.timestamp > r.deadline) revert RequestExpired();
        r.targetBlock = uint64(block.number); r.randomness = word; r.fulfilled = true;
        _deliver(id, r, deliveryGas);
    }

    function retryCallback(uint256 id, uint32 gasLimit) external {
        Request storage r = _request(id);
        if (!r.fulfilled) revert NotFulfilled();
        if (r.delivered) revert AlreadyDelivered();
        if (gasLimit < 30_000 || gasLimit > 1_000_000 || gasLimit < r.callbackGasLimit) revert InvalidCallbackGas();
        _deliver(id, r, gasLimit);
    }

    function _deliver(uint256 id, Request storage r, uint32 gasLimit) private {
        if (gasleft() < uint256(gasLimit) + uint256(gasLimit) / 63 + 140_000) revert InsufficientCallbackGas();
        uint256 before = gasleft();
        (bool ok,) = r.consumer.call{gas: gasLimit}(abi.encodeCall(ID20VRFConsumer.rawFulfillRandomness, (id, r.randomness)));
        emit CallbackGasUsed(id, before - gasleft());
        r.delivered = ok;
        emit CallbackAttempted(id, ok, gasLimit);
    }

    function refundRequest(uint256 id) external {
        Request storage r = _request(id);
        if (r.fulfilled || r.refunded || block.timestamp <= r.deadline) revert RefundNotAvailable();
        r.refunded = true;
        uint256 amount = requestFeePaid[id];
        refundCredits[r.refundAddress] += amount;
        if (gasleft() < 100_000 + uint256(100_000) / 63 + 140_000) revert InsufficientCallbackGas();
        (bool paid,) = r.refundAddress.call{value: amount, gas: 30_000}("");
        if (paid) refundCredits[r.refundAddress] -= amount;
        emit RequestRefundedTo(id, r.refundAddress, amount, paid);
        (bool ignored,) = r.consumer.call{gas: 100_000}(abi.encodeCall(ID20VRFRefundConsumer.onRefund, (id)));
        ignored;
    }

    function withdrawRefundCredit(address payable recipient) external {
        uint256 amount = refundCredits[msg.sender];
        if (amount == 0) revert NoRefundCredit();
        refundCredits[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok);
    }

    function getRequest(uint256 id) external view returns (Request memory) { return _request(id); }
    function getMapping(uint256 id) external view returns (RandomnessMapping.Spec memory) { _request(id); return specs[id]; }
    function getMappedResult(uint256 id) external view returns (uint256[] memory) {
        Request storage r = _request(id);
        if (!r.fulfilled) revert NotFulfilled();
        return RandomnessMapping.map(r.randomness, specs[id]);
    }
    function mapRandomness(bytes32 word, RandomnessMapping.Spec calldata spec) external pure returns (uint256[] memory) {
        return RandomnessMapping.map(word, spec);
    }

    function _request(uint256 id) private view returns (Request storage r) {
        r = requests[id];
        if (r.consumer == address(0)) revert UnknownRequest();
    }
}
