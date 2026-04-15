# Maple Finance 智能合約改進建議

> 基於原始碼層級的深度分析，涵蓋安全性、經濟模型、Gas 效率與架構設計。
> 所有發現均已透過 GitHub 原始碼驗證。

---

## 嚴重程度分級

| 等級 | 說明 |
|---|---|
| **HIGH** | 可能導致資金損失或兌換率操控 |
| **MEDIUM** | 影響公平性、Gas 效率或營運安全 |
| **LOW** | 設計權衡或邊界情況，影響有限 |

---

## 1. [HIGH] Open-Term LoanManager 幽靈利息無限累積

### 問題

Open-Term LoanManager 的 `accruedInterest()` **沒有 `domainEnd` 上限**：

```solidity
// Open-Term LoanManager
function accruedInterest() public view returns (uint256) {
    if (issuanceRate == 0) return 0;
    return issuanceRate * (block.timestamp - domainStart) / 1e27;
    //                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                     無上限，持續累積
}

// 對比 Fixed-Term LoanManager（有上限）
function accruedInterest() public view returns (uint256) {
    if (issuanceRate == 0) return 0;
    return issuanceRate * (min(block.timestamp, domainEnd) - domainStart) / 1e30;
    //                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                     在 domainEnd 處截止
}
```

當借款人停止還款時，利息持續累積到 `totalAssets()` 中，**虛高兌換率**。而減值（impairment）完全依賴 Pool Delegate 手動觸發：

```solidity
function impairLoan(address loan_) external override {
    require(msg.sender == _governor() || msg.sender == _poolDelegate(), "LM:IL:NO_AUTH");
    // 完全手動，無自動機制
}
```

### 影響

- 兌換率被虛假利息膨脹 → 新存款人獲得更少份額
- 當貸款最終違約時，兌換率驟降 → 期間進入的 LP 承受放大損失
- Pool Delegate 若疏忽或被妥協，幽靈累積可無限延續

### 建議

```solidity
// 方案 A：引入自動減值閾值
function accruedInterest() public view returns (uint256) {
    uint256 elapsed = block.timestamp - domainStart;
    // 如果超過寬限期（如 30 天）未還款，停止累積
    uint256 cappedElapsed = _min(elapsed, paymentGracePeriod);
    return issuanceRate * cappedElapsed / PRECISION;
}

// 方案 B：引入 Keeper 機制自動觸發減值
function autoImpairOverdueLoan(address loan_) external {
    require(block.timestamp > lastPaymentDate[loan_] + gracePeriod, "NOT_OVERDUE");
    _impairLoan(loan_);
    // 可給 Keeper 少量 Gas 補償
}
```

---

## 2. [HIGH] 外部策略兌換率可被閃電貸操控

### 問題

`deposit()` 在同一筆交易中讀取 `totalAssets()`，而 `totalAssets()` 依賴外部策略的即時估值：

```solidity
// Pool.deposit() → convertToShares() → totalAssets() → PoolManager.totalAssets()
function totalAssets() public view returns (uint256 totalAssets_) {
    totalAssets_ = IERC20Like(asset).balanceOf(pool);  // 閒置現金
    for (uint256 i_; i_ < length_;) {
        totalAssets_ += IStrategyLike(strategyList[i_]).assetsUnderManagement();
        //              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
        //              讀取外部協議的即時價格
    }
}

// BasicStrategy 調用外部 ERC-4626 vault 的 previewRedeem
function _currentTotalAssets(address strategyVault_) internal view returns (uint256) {
    uint256 currentTotalShares_ = IERC20Like(strategyVault_).balanceOf(address(this));
    return IERC4626Like(strategyVault_).previewRedeem(currentTotalShares_);
    //     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //     可被同一交易中的捐贈攻擊操控
}
```

### 攻擊流程

1. 攻擊者閃電貸大量資產
2. 捐贈到外部 ERC-4626 vault，膨脹 `previewRedeem` 回傳值
3. `totalAssets()` 被膨脹 → `convertToShares()` 回傳更少份額
4. 受害者的 `deposit()` 在同一區塊執行，獲得被低估的份額
5. 攻擊者撤回捐贈，`totalAssets()` 回歸正常

### 現有緩解

- BOOTSTRAP_MINT 防止首次存款攻擊
- 策略金庫白名單（`isInstanceOf("STRATEGY_VAULT", ...)`）
- 外部金庫本身的閃電貸防護

### 建議

```solidity
// 方案：引入策略估值的 TWAP 或延遲讀取
mapping(address => uint256) lastKnownAUM;
mapping(address => uint256) lastUpdateTimestamp;

function totalAssets() public view returns (uint256 totalAssets_) {
    totalAssets_ = IERC20Like(asset).balanceOf(pool);
    for (uint256 i_; i_ < length_;) {
        // 如果策略估值在同一區塊內變化超過閾值，使用上次已知值
        uint256 currentAUM = IStrategyLike(strategyList[i_]).assetsUnderManagement();
        uint256 lastAUM = lastKnownAUM[strategyList[i_]];
        if (lastUpdateTimestamp[strategyList[i_]] == block.timestamp
            && _percentChange(currentAUM, lastAUM) > MAX_SINGLE_BLOCK_CHANGE) {
            totalAssets_ += lastAUM;  // 使用上一區塊的值
        } else {
            totalAssets_ += currentAUM;
        }
    }
}
```

---

## 3. [HIGH] Fixed-Term LoanManager 過期 Domain 導致 totalAssets 低報

### 問題

當 `block.timestamp > domainEnd` 且無人觸發狀態更新時，`accruedInterest()` 停止在 `domainEnd`：

```solidity
accruedInterest_ = issuanceRate_ * (min(block.timestamp, domainEnd) - domainStart) / PRECISION;
//                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                  到 domainEnd 後不再增長
```

已到期但未 claim 的還款利息不會被計入 `accountedInterest`，直到有人呼叫 `_advanceGlobalPaymentAccounting()`。

### 影響

- `totalAssets()` 被低報 → 存款人以虛低兌換率獲得更多份額
- 等同於稀釋現有 LP 的權益
- 套利：在低報期間存款，等 `claim()` 觸發後兌換率恢復再提款

### 現有緩解

- `updateAccounting()` 可由 Pool Delegate 或 Governor 手動呼叫
- 每次 `fund()`、`claim()` 等狀態改變操作都會觸發更新

### 建議

```solidity
// 方案：存款前自動推進會計
function deposit(uint256 assets_, address receiver_) external nonReentrant checkCall("P:deposit")
    returns (uint256 shares_)
{
    // 在計算份額前，確保所有策略會計為最新
    IPoolManagerLike(manager).updateAllAccounting();
    _mint(shares_ = previewDeposit(assets_), assets_, receiver_, msg.sender);
}
```

---

## 4. [MEDIUM] 策略列表只增不減，Gas 成本持續膨脹

### 問題

`strategyList` 只能 `push`，無法移除：

```solidity
function addStrategy(...) external returns (address strategy_) {
    // ...
    strategyList.push(strategy_);
    isStrategy[strategy_] = true;
}

// setIsStrategy 只能停用，不能從列表移除
function setIsStrategy(address strategy_, bool isStrategy_) external {
    isStrategy[strategy_] = isStrategy_;
    // strategyList 不變！停用的策略仍被遍歷
}
```

而 `totalAssets()` 和 `unrealizedLosses()` 都遍歷整個列表：

```solidity
function totalAssets() public view returns (uint256 totalAssets_) {
    totalAssets_ = IERC20Like(asset).balanceOf(pool);
    for (uint256 i_; i_ < strategyList.length;) {  // 遍歷所有策略，包括停用的
        totalAssets_ += IStrategyLike(strategyList[i_]).assetsUnderManagement();
    }
}
```

### 影響

- 每次 `deposit()`、`withdraw()`、`transfer()` 都觸發 `totalAssets()` → 遍歷所有策略
- 停用的策略仍產生外部 call 開銷（即使回傳 0）
- 長期運營後 Gas 成本線性增長
- 理論上可能達到區塊 Gas 限制，造成 DoS

### 建議

```solidity
// 方案：實現策略移除機制（swap-and-pop 模式）
function removeStrategy(uint256 index_) external onlyProtocolAdmins {
    address strategy_ = strategyList[index_];
    require(!isStrategy[strategy_], "STILL_ACTIVE");
    require(IStrategyLike(strategy_).assetsUnderManagement() == 0, "HAS_ASSETS");

    // Swap with last element and pop
    uint256 lastIndex_ = strategyList.length - 1;
    if (index_ != lastIndex_) {
        strategyList[index_] = strategyList[lastIndex_];
    }
    strategyList.pop();
}
```

---

## 5. [MEDIUM] 週期性提款管理器：小額 LP 在極端壓力下的捨入歧視

### 問題

按比例分配使用整數除法：

```solidity
redeemableShares_ = lockedShares_ * availableLiquidity_ / totalRequestedLiquidity_;
```

### 範例

- 小 LP 持有 1 share，可用流動性 5 USDC，總請求 10,000 shares
- `1 * 5 / 10000 = 0`（整數除法捨入為零）
- 小 LP 什麼都拿不到，但大 LP 可正常提取

### 同時存在的 Gas 浪費問題

即使贖回金額為零，LP 仍需在每個窗口期呼叫 `processExit` 並支付 Gas：

```solidity
// 零流動性時：LP 花 Gas 但得到 0 資產
if (lockedShares_ != 0) {
    exitCycleId_ = getCurrentCycleId() + 1;  // 重新排到下一週期
    totalCycleShares[exitCycleId_] += lockedShares_;
}
```

### 建議

```solidity
// 方案 A：累積捨入餘數到下一週期
mapping(address => uint256) public roundingRemainder;

function _calculateRedeemable(...) internal returns (uint256) {
    uint256 raw = lockedShares_ * availableLiquidity_ + roundingRemainder[owner_];
    uint256 shares = raw / totalRequestedLiquidity_;
    roundingRemainder[owner_] = raw % totalRequestedLiquidity_;
    return shares;
}

// 方案 B：設定最小贖回閾值，低於閾值自動跳過（不花 Gas）
```

---

## 6. [MEDIUM] 佇列式提款管理器：粉塵請求 DoS

### 問題

任何人可建立 1 share 的提款請求，且取消無懲罰：

```solidity
// processRedemptions 必須逐一處理每個請求
while (maxSharesToProcess_ > 0 && nextRequestId_ <= lastRequestId_) {
    (uint256 sharesProcessed_, bool isProcessed_) = _processRequest(nextRequestId_, ...);
    if (!isProcessed_) break;
    maxSharesToProcess_ -= sharesProcessed_;
    ++nextRequestId_;
}
```

攻擊者可建立數千個 1 share 請求，使 `processRedemptions` 的 Gas 成本暴增。

### 建議

```solidity
// 方案 A：最小份額門檻
function addShares(uint256 shares_, address owner_) external {
    require(shares_ >= MIN_WITHDRAWAL_SHARES, "WM:AS:DUST");
    // ...
}

// 方案 B：取消提款收取小額費用防止 spam
function removeShares(uint256 sharesToRemove_) external {
    require(
        block.timestamp > requestTimestamp[msg.sender] + MIN_HOLD_PERIOD,
        "WM:RS:TOO_SOON"
    );
    // ...
}
```

---

## 7. [MEDIUM] PoolPermissionManager：PUBLIC 權限為不可逆單向門

### 問題

一旦設為 PUBLIC，永遠無法回到受許可狀態：

```solidity
function configurePool(...) external {
    require(permissionLevels[poolManager_] != PUBLIC, "PPM:CP:PUBLIC_POOL");
    // 已經是 PUBLIC 的池，此函數永遠 revert
}
```

### 影響

- 誤操作設為 PUBLIC → 池永久對所有人開放，無法恢復 KYC 控制
- 合規風險：監管環境變化時無法重新加入限制

### 建議

```solidity
// 方案：允許 Governor 在緊急情況下降級權限
function emergencyRestrictPool(address poolManager_, uint256 newLevel_) external {
    require(msg.sender == governor, "PPM:ERP:NO_AUTH");
    require(newLevel_ < PUBLIC, "PPM:ERP:INVALID_LEVEL");
    permissionLevels[poolManager_] = newLevel_;
    emit PoolPermissionLevelSet(poolManager_, newLevel_);
}
```

---

## 8. [MEDIUM] 空 poolBitmap 繞過權限檢查

### 問題

```solidity
function _hasPermission(...) internal view returns (bool) {
    // ...
    uint256 poolBitmap_ = poolBitmaps[poolManager_][functionId_];
    return (poolBitmap_ & lenderBitmaps[lender_]) == poolBitmap_;
    //      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //      若 poolBitmap_ = 0，則 (0 & anything) == 0 → 永遠為 true
}
```

### 影響

在 `FUNCTION_LEVEL` 或 `POOL_LEVEL` 模式下，若 Pool Delegate 忘記設置 bitmap → 所有人都能通過權限檢查。

### 建議

```solidity
// 在 configurePool 中強制要求非零 bitmap
function configurePool(address poolManager_, uint256 permissionLevel_, bytes32[] bitmaps_) external {
    if (permissionLevel_ == FUNCTION_LEVEL || permissionLevel_ == POOL_LEVEL) {
        for (uint256 i; i < bitmaps_.length; i++) {
            require(uint256(bitmaps_[i]) != 0, "PPM:CP:ZERO_BITMAP");
        }
    }
    // ...
}
```

---

## 9. [MEDIUM] 清算機制的 MEV 提取

### 問題

`liquidatePortion` 為無許可函數，任何人可呼叫且附帶任意回呼：

```solidity
function liquidatePortion(uint256 collateralAmount_, uint256 maxReturnAmount_, bytes calldata data_)
    external nonReentrant
{
    uint256 returnAmount_ = getExpectedAmount(collateralAmount_);
    // 1. 先給抵押品
    ERC20Helper.transfer(collateralAsset, msg.sender, collateralAmount_);
    // 2. 任意回呼（return value 未檢查）
    msg.sender.call(data_);
    // 3. 拉回 fundsAsset
    ERC20Helper.transferFrom(fundsAsset, msg.sender, address(this), returnAmount_);
}
```

### 影響

- MEV 機器人可搶跑所有清算交易
- `allowedSlippageFor` 設得太寬鬆 → 協議承受不必要損失
- Oracle 價格操控可降低 `returnAmount_`，使抵押品被低價賣出

### 建議

```solidity
// 方案 A：引入清算者白名單或拍賣機制
mapping(address => bool) public approvedLiquidators;

function liquidatePortion(...) external {
    require(approvedLiquidators[msg.sender] || block.timestamp > liquidationStart + OPEN_PERIOD,
        "LIQ:LP:NOT_APPROVED");
    // 前 N 小時僅白名單清算者可參與，之後開放給所有人
}

// 方案 B：荷蘭拍賣（隨時間增加折扣，減少 MEV 利潤空間）
function getExpectedAmount(uint256 collateralAmount_) public view returns (uint256) {
    uint256 elapsed = block.timestamp - liquidationStart;
    uint256 discount = _min(elapsed * DISCOUNT_RATE_PER_SECOND, MAX_DISCOUNT);
    return oracleAmount * (HUNDRED_PERCENT - discount) / HUNDRED_PERCENT;
}
```

---

## 10. [LOW] `processWithdraw` 永久停用

### 問題

```solidity
function processWithdraw(...) external returns (...) {
    require(false, "PM:PW:NOT_ENABLED");  // 永遠 revert
}
```

ERC-4626 標準定義了 `withdraw`（基於資產金額）和 `redeem`（基於份額數量），但 Maple 永久停用了 `withdraw` 路徑。

### 影響

- 降低 ERC-4626 相容性，整合方可能因預期 `withdraw` 可用而失敗
- 任何依賴 `withdraw` 的聚合器或路由合約會無預警 revert

### 建議

至少在文檔中明確說明此限制，或在 `withdraw` 中實現到 `redeem` 的自動轉換。

---

## 11. [LOW] 精度不一致：Fixed-Term vs Open-Term

### 問題

| LoanManager 類型 | PRECISION | 說明 |
|---|---|---|
| Fixed-Term | `1e30` | 較高精度 |
| Open-Term | `1e27` | 較低精度 |

### 影響

- 同一池中同時使用兩種 LoanManager 時，精度差異可能導致微小的捨入差異累積
- 開發者整合時可能混淆精度常數

### 建議

統一使用相同精度常數，或在 PoolManager 聚合時做明確的精度對齊。

---

## 改進優先級總結

| # | 嚴重程度 | 問題 | 建議 |
|---|---|---|---|
| 1 | **HIGH** | Open-Term 幽靈利息無限累積 | 引入自動減值或 Keeper 機制 |
| 2 | **HIGH** | 外部策略兌換率閃電貸操控 | TWAP / 單區塊變化限制 |
| 3 | **HIGH** | Fixed-Term 過期 domain 低報 totalAssets | 存款前自動推進會計 |
| 4 | **MEDIUM** | 策略列表只增不減 | 實現 swap-and-pop 移除 |
| 5 | **MEDIUM** | 週期性提款小 LP 捨入歧視 | 累積捨入餘數 |
| 6 | **MEDIUM** | 佇列提款粉塵 DoS | 最小份額門檻 |
| 7 | **MEDIUM** | PUBLIC 權限不可逆 | Governor 緊急降級功能 |
| 8 | **MEDIUM** | 空 bitmap 繞過權限 | 強制非零 bitmap |
| 9 | **MEDIUM** | 清算 MEV 提取 | 荷蘭拍賣或白名單期 |
| 10 | **LOW** | processWithdraw 停用 | 文檔標註或自動轉換 |
| 11 | **LOW** | 精度不一致 | 統一精度常數 |

---

## 資料來源

- [MaplePool.sol](https://github.com/maple-labs/pool-v2/blob/main/contracts/MaplePool.sol)
- [MaplePoolManager.sol](https://github.com/maple-labs/pool-v2/blob/main/contracts/MaplePoolManager.sol)
- [Fixed-Term LoanManager.sol](https://github.com/maple-labs/fixed-term-loan-manager/blob/main/contracts/LoanManager.sol)
- [Open-Term LoanManager.sol](https://github.com/maple-labs/open-term-loan-manager/blob/main/contracts/LoanManager.sol)
- [MapleBasicStrategy.sol](https://github.com/maple-labs/maple-strategies/blob/main/contracts/MapleBasicStrategy.sol)
- [MapleAaveStrategy.sol](https://github.com/maple-labs/maple-strategies/blob/main/contracts/MapleAaveStrategy.sol)
- [MapleSkyStrategy.sol](https://github.com/maple-labs/maple-strategies/blob/main/contracts/MapleSkyStrategy.sol)
- [Cyclical WithdrawalManager](https://github.com/maple-labs/withdrawal-manager-cyclical)
- [Queue WithdrawalManager](https://github.com/maple-labs/withdrawal-manager-queue)
- [MaplePoolPermissionManager.sol](https://github.com/maple-labs/pool-permission-manager)
- [Liquidator.sol](https://github.com/maple-labs/liquidations/blob/main/contracts/Liquidator.sol)
