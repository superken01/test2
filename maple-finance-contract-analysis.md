# Maple Finance 智能合約架構分析

## 1. 協議概述

Maple Finance 是建立在 Ethereum 上的去中心化機構信用市場，透過全球可訪問的固定收益機會，為機構借款人提供資金。協議經歷了多個主要版本的演進，其中 V2 代表了一次根本性的架構重構。

---

## 2. GitHub 組織與關鍵倉庫

`maple-labs` GitHub 組織 (https://github.com/maple-labs) 擁有約 69 個倉庫。核心倉庫如下：

| 倉庫 | 說明 |
|---|---|
| `maple-core-v2` | 整合測試中心；將所有 V2 子模組作為依賴導入 |
| `revenue-distribution-token` | ERC-4626 相容代幣，用於分配歸屬協議收入 |
| `maple-core` | 原始 V1 協議（已棄用） |
| `erc20` | Maple 自定義 ERC-20 實現 |
| `pool-v2` | Pool, PoolManager, PoolDelegateCover, PoolDeployer |
| `fixed-term-loan` | 固定期限貸款的 MapleLoan + MapleLoanFeeManager |
| `open-term-loan` | 開放期限貸款的 MapleLoan |
| `globals-v2` | MapleGlobals 單例，用於全協議配置 |
| `proxy-factory` | 通用 ProxyFactory 基礎合約 |
| `maple-proxy-factory` | Maple 特定的 ProxyFactory 擴展 |
| `non-transparent-proxy` | EIP-1967 代理，用於非工廠型可升級合約（如 MapleGlobals） |
| `liquidations` | 違約貸款的 Liquidator 合約 |
| `withdrawal-manager-cyclical` | 週期性（時間窗口）提款機制 |
| `withdrawal-manager-queue` | 基於佇列（FIFO）的提款機制 |
| `pool-permission-manager` | 資金池參與的存取控制/白名單 |
| `xMPL` | MPL 質押者的收入累積代幣 |
| `strategies` | 資金池的投資策略合約 |
| `syrup-utils` | Syrup 產品的工具合約（SyrupRouter 等） |
| `address-registry` | 已部署合約地址的鏈上註冊表 |

> `maple-core-v2` 是中央整合點——本身不包含合約原始碼，而是將上述所有模組作為子模組導入，提供整合測試、端對端測試、模糊測試、不變量測試和場景模擬。

---

## 3. 協議角色

| 角色 | 說明 |
|---|---|
| **Governor** | 協議管理員（逐步走向 DAO 治理）。在 MapleGlobals 中配置所有全協議參數，管理工廠白名單，啟用資金池，控制時間鎖升級 |
| **Security Admin** | 可觸發代理合約的緊急升級 |
| **Operational Admin** | 可啟用 Pool Manager 並與 Governor 一起配置特定 Globals 參數 |
| **Pool Delegate** | 管理特定貸款池。評估借款人、資助貸款、配置池參數（費用、提款設置），並賺取績效費用。每個池恰好有一個 Pool Delegate |
| **Liquidity Providers (LPs)** | 將資產存入資金池以賺取收益。僅與 `MaplePool` 合約（ERC-4626 接口）互動 |
| **Borrowers** | 創建貸款請求、提交抵押品、提取資金，並按約定條款進行還款 |

---

## 4. 核心智能合約及其職責

### 4.1 MapleGlobals（單例）

- **倉庫**: `globals-v2`
- **合約**: `MapleGlobals.sol`（繼承 `NonTransparentProxied`）
- **職責**: 全協議配置中心
  - 允許的借款人、抵押資產、池資產白名單
  - 平台費率（發起費、管理費、服務費）
  - 價格預言機（Chainlink）
  - 工廠白名單（`isInstanceOf` 映射）
  - Pool Delegate 註冊表
  - 排程調用的時間鎖參數（用於受控升級）
  - 協議暫停狀態
- 使用 **NonTransparentProxy** 模式（EIP-1967 管理員插槽），不使用工廠模式（因為是單例）

### 4.2 MaplePool

- **倉庫**: `pool-v2` — `MaplePool.sol`
- **繼承**: `ERC20`（Maple 自定義實現）
- **實現**: ERC-4626 代幣化金庫標準
- **職責**: LP 面向的合約，設計上刻意保持簡單
  - `deposit()` / `depositWithPermit()` / `mint()` / `mintWithPermit()` — 存入資產，獲得份額
  - `redeem()` / `withdraw()` — 銷毀份額，獲得資產
  - `requestRedeem()` / `requestWithdraw()` — 發起提款請求
  - `removeShares()` — 取消提款請求
- 所有函數都由 `checkCall` 修飾符控制，委託給 `PoolManager.canCall()` 進行授權
- 具有不可變的 `manager`（PoolManager）和 `asset`（底層 ERC-20）引用
- 包含 bootstrap mint 機制以防止首個存款者的通膨攻擊
- 所有狀態改變函數都有重入防護

### 4.3 MaplePoolManager

- **倉庫**: `pool-v2` — `MaplePoolManager.sol`
- **繼承**: `MapleProxiedInternals`（可透過工廠模式升級）
- **職責**: 每個資金池的管理核心
  - 資金池配置和生命週期管理
  - 添加策略（通過 `addStrategy()` 調用工廠的 `createInstance`）
  - 設置委託人管理費率
  - 處理贖回和提款（委託給 WithdrawalManager）
  - 通過 `canCall()` 進行權限檢查（整合 `PoolPermissionManager`）
  - 貸款資助接口——連接到 LoanManagers
  - 管理 `poolDelegateCover` 合約
  - Pool Delegate 所有權轉移（兩步模式）
  - 升級機制：Pool Delegate（通過 Globals 的排程調用）或 Security Admin 可觸發升級
- 與其 Pool 為 **1:1** 關係
- 可擁有**多個 LoanManagers** 和**多個 Strategies**

### 4.4 PoolDelegateCover

- **倉庫**: `pool-v2` — `MaplePoolDelegateCover.sol`
- **職責**: 代表 Pool Delegate 持有第一損失資本（first-loss capital）的託管合約。當貸款違約時，此資本優先承擔損失，使委託人的利益與 LP 保持一致

### 4.5 PoolDeployer

- **倉庫**: `pool-v2` — `MaplePoolDeployer.sol`
- **職責**: 原子性地部署新資金池及其所有必要依賴（Pool + PoolManager + PoolDelegateCover + WithdrawalManager）

### 4.6 MapleLoan（固定期限）

- **倉庫**: `fixed-term-loan` — `MapleLoan.sol`
- **繼承**: `MapleProxiedInternals`, `MapleLoanStorage`
- **職責**: 代表貸方（代表資金池的 LoanManager）和借款人之間的固定期限貸款協議
  - 貸款條款接受
  - 資金注入和提取
  - 抵押品管理
  - 還款計算（攤銷型和僅付息型）
  - `makePayment()` / `closeLoan()` / `returnFunds()`
  - 違約時的抵押品扣押
  - 再融資（貸方和借方同意新條款）
  - 通過代理模式升級
- 關鍵修飾符：`limitDrawableUse` 防止非借款人調用者減少可提取資金
- `whenNotPaused` 修飾符檢查 Globals 暫停狀態

### 4.7 MapleLoan（開放期限）

- **倉庫**: `open-term-loan`
- **職責**: 與固定期限相同，但沒有固定到期日。借款人持續支付利息；任何一方都可以觸發還款/召回

### 4.8 MapleLoanFeeManager

- **倉庫**: `fixed-term-loan` — `MapleLoanFeeManager.sol`
- **職責**: 貸款的集中費用計算和分配
  - 發起費（在 Pool Delegate 和 Maple Treasury 之間分配）
  - 服務費（持續性，按每次還款）
  - 再融資服務費
  - 所有費率可按每筆貸款配置，從 Globals 提取

### 4.9 LoanManagers（固定期限和開放期限）

- **倉庫**: `fixed-term-loan-manager`, `open-term-loan-manager`
- **職責**: PoolManager 和個別貸款之間的會計層
  - 一個 PoolManager 可有**多個** LoanManagers
  - 一個 LoanManager 僅報告給**一個** PoolManager
  - 從 MapleLoan 的角度充當「貸方」
- 處理：利息應計追蹤、還款認領、違約觸發、減值

### 4.10 WithdrawalManager（週期性）

- **倉庫**: `withdrawal-manager-cyclical`
- **繼承**: `MapleProxiedInternals`（可升級）
- **職責**: 通過時間窗口週期管理 LP 提款。LP 請求贖回後，份額被鎖定直到下一個提款窗口。當流動性不足時，支持按比例分配

### 4.11 WithdrawalManager（佇列式）

- **倉庫**: `withdrawal-manager-queue`
- **職責**: 使用 FIFO 佇列的替代提款機制。為 Pool Delegate 提供靈活性，選擇最適合其池的提款方式

### 4.12 Liquidator

- **倉庫**: `liquidations`
- **繼承**: `MapleProxiedInternals`（可升級）
- **職責**: 當貸款違約時由 Pool Delegate 觸發。通過基於閃電貸的清算機制，從剩餘抵押資產中儘可能多地恢復流動性，將抵押品轉換為池資產

### 4.13 PoolPermissionManager

- **倉庫**: `pool-permission-manager`
- **職責**: 控制誰可以存入、提取或轉移池份額。實現 KYC/AML 合規和許可池訪問

### 4.14 RevenueDistributionToken (xMPL)

- **倉庫**: `revenue-distribution-token`
- **實現**: ERC-4626
- **職責**: 使用線性歸屬機制將累積的協議收入分配給 MPL 質押者。收入存入更新發行率，將未歸屬的 + 新收入分攤到新的歸屬期間，防止質押者在大額分配前後進出的套利行為

### 4.15 Strategies

- **倉庫**: `strategies`
- **職責**: 可附加到資金池的投資策略合約。通過 `PoolManager.addStrategy()` 的工廠模式部署

---

## 5. 設計模式

### 5.1 代理模式（兩種變體）

#### a) 工廠管理代理（用於多實例合約）

- **使用者**: MapleLoan, PoolManager, LoanManagers, WithdrawalManagers, Liquidator, Strategies
- **實現**: `proxy-factory` → `maple-proxy-factory`
- **運作方式**:
  1. `Proxy.sol` 是最小化的委託調用代理，在 EIP-1967 存儲插槽中存儲工廠地址和實現地址
  2. `ProxyFactory` 管理 `version → implementation` 映射和 `(fromVersion, toVersion) → migrator` 映射的註冊表
  3. `MapleProxyFactory` 擴展 ProxyFactory，添加 Maple 特定的訪問控制（Governor 管理實現和升級路徑）
  4. 每個代理實例通過 `delegatecall` 將所有調用委託給其實現
  5. 升級遵循受控路徑：Governor 註冊實現並啟用特定升級路徑；代理的 `upgrade()` 調用 `factory.upgradeInstance()` 設定新實現並運行遷移器合約
  6. 當 `fromVersion == toVersion` 時，遷移器充當初始化器

#### b) 非透明代理（用於單例）

- **使用者**: MapleGlobals
- **實現**: `non-transparent-proxy`
- 更簡單的 EIP-1967 代理，只有管理員（Governor）可以更改實現。不涉及工廠

### 5.2 工廠模式

- 每種多實例合約類型都有對應的工廠：
  - `MapleLoanFactory`（固定期限和開放期限貸款）
  - `PoolManagerFactory`
  - `WithdrawalManagerFactory`（週期性和佇列式變體）
  - `LiquidatorFactory`
  - Strategy 工廠
- 工廠在 `MapleGlobals.isInstanceOf` 映射中註冊
- Governor 控制哪些工廠有效、每個版本存在哪些實現、啟用哪些升級路徑
- 工廠創建的實例可被驗證：`IProxyFactoryLike(factory).isInstance(instanceAddress)`

### 5.3 排程調用 / 時間鎖模式

- `MapleGlobals` 為敏感操作（特別是升級）實現了時間鎖機制
- 調用者使用 `scheduleCall()` 排程調用，記錄時間戳 + calldata 雜湊
- 在配置的 `delay` 之後且在 `duration` 窗口內，可以執行實際調用
- 由目標合約升級函數中的 `isValidScheduledCall()` 驗證

### 5.4 兩步所有權轉移

- 用於 Governor 轉移（`setPendingGovernor` → `acceptGovernor`）
- 用於 Pool Delegate 轉移（`setPendingPoolDelegate` → `acceptPoolDelegate`）
- 防止意外轉移到錯誤地址

### 5.5 關注點分離

- **Pool** 刻意保持最小化（ERC-20 + ERC-4626 金庫）
- **PoolManager** 持有所有管理邏輯
- **LoanManager** 處理貸款會計
- **MapleLoan** 處理貸款生命週期
- **MapleLoanFeeManager** 處理費用計算
- **WithdrawalManager** 處理提款調度
- 這種模組化設計允許每個組件獨立升級

---

## 6. 合約互動依賴圖

```
                    MapleGlobals（單例，NonTransparentProxy）
                          |
          ----------------+------------------
          |               |                 |
     工廠白名單       費用配置          Pool Delegate
                    預言機價格            註冊表
          |
    +-----+------+--------+----------+
    |            |         |          |
PoolManager   Loan      Withdrawal  Liquidator
  Factory    Factories  Factories    Factory
    |            |         |          |
    v            v         v          v
PoolManager  MapleLoan  Withdrawal  Liquidator
  (proxy)    (proxy)    Manager       (proxy)
    |            |      (proxy)
    |            |         |
    +----+-------+---------+
         |
    MaplePool <===> PoolManager <===> LoanManager(s)
    (ERC-4626)       |                     |
         |           |                MapleLoan(s)
    PoolDelegate     |
      Cover          |
                     +--- WithdrawalManager(s)
                     |
                     +--- PoolPermissionManager
                     |
                     +--- Strategy(s)
```

---

## 7. 核心業務流程

### 7.1 資金池創建

1. Governor 或 Operational Admin 在 `MapleGlobals` 中註冊 Pool Delegate
2. `PoolDeployer.deployPool()` 原子性創建：MaplePool（通過構造器）、PoolManager（通過 PoolManagerFactory）、PoolDelegateCover、WithdrawalManager（通過工廠）
3. Governor 通過 `MapleGlobals.activatePoolManager()` 啟用資金池

### 7.2 存款流程（LP → Pool）

1. LP 調用 `MaplePool.deposit(assets, receiver)` 或 `mint(shares, receiver)`
2. Pool 的 `checkCall` 修飾符詢問 `PoolManager.canCall("P:deposit", sender, data)`，再檢查 `PoolPermissionManager`
3. Pool 通過 ERC-4626 `previewDeposit()` 計算份額（基於 totalAssets，包含未結貸款利息）
4. Pool 從 LP 轉移底層資產，向接收者鑄造份額

### 7.3 貸款資助流程

1. 借款人和 Pool Delegate 在鏈下協商條款
2. Pool Delegate 通過 PoolManager 調用適當的 LoanManager 資助貸款
3. LoanManager 調用 `MapleLoan.fundLoan()`，將池資產轉移到貸款合約
4. 借款人在提交所需抵押品後調用 `MapleLoan.drawdownFunds()`

### 7.4 還款流程

1. 借款人調用 `MapleLoan.makePayment()`，支付本金 + 利息 + 費用
2. MapleLoan 調用 `MapleLoanFeeManager.payServiceFees()`，將費用分配給 Pool Delegate 和 Maple Treasury
3. 剩餘資金（本金 + 利息）由 LoanManager 認領
4. LoanManager 更新會計記錄並向 PoolManager 報告，增加池的 `totalAssets`

### 7.5 提款流程

1. LP 調用 `MaplePool.requestRedeem(shares, owner)`，份額被鎖定在 WithdrawalManager 中
2. 提款窗口/佇列允許後，LP 調用 `MaplePool.redeem(shares, receiver, owner)`
3. Pool 調用 `PoolManager.processRedeem()`，委託給 WithdrawalManager
4. WithdrawalManager 計算可贖回金額（流動性不足時按比例分配）
5. Pool 銷毀份額並將資產轉移給接收者

### 7.6 違約/清算流程

1. 借款人錯過還款，Pool Delegate 可通過 LoanManager 觸發違約
2. LoanManager 調用 `MapleLoan.repossess()` 扣押抵押品
3. 抵押品被發送到 Liquidator 合約
4. Liquidator 通過閃電貸機制將抵押品轉換為池資產
5. 回收的資金返回池中；損失首先由 PoolDelegateCover 吸收，然後由 LP 份額承擔

---

## 8. 技術棧

| 項目 | 說明 |
|---|---|
| **語言** | Solidity (^0.8.7 / ^0.8.25，依模組而異) |
| **建構/測試框架** | Foundry (forge) |
| **授權** | BUSL 1.1（大多數合約）、AGPL v3（代理基礎設施） |
| **標準** | ERC-20, ERC-4626, ERC-2612 (permit) |
| **審計方** | Trail of Bits, Spearbit/Cantina, Three Sigma, 0xMacro, Code4rena |
| **漏洞懸賞** | Immunefi 活躍中 |

---

## 9. 資料來源

- [Maple Finance Smart Contract Architecture (docs.maple.finance)](https://docs.maple.finance/technical-resources/protocol-overview/smart-contract-architecture)
- [maple-labs GitHub Organization](https://github.com/maple-labs)
- [maple-core-v2 Repository](https://github.com/maple-labs/maple-core-v2)
- [pool-v2 Repository](https://github.com/maple-labs/pool-v2)
- [fixed-term-loan Repository](https://github.com/maple-labs/fixed-term-loan)
- [open-term-loan Repository](https://github.com/maple-labs/open-term-loan)
- [globals-v2 Repository](https://github.com/maple-labs/globals-v2)
- [maple-proxy-factory Repository](https://github.com/maple-labs/maple-proxy-factory)
- [revenue-distribution-token Repository](https://github.com/maple-labs/revenue-distribution-token)
- [withdrawal-manager-cyclical Repository](https://github.com/maple-labs/withdrawal-manager-cyclical)
- [withdrawal-manager-queue Repository](https://github.com/maple-labs/withdrawal-manager-queue)
- [liquidations Repository](https://github.com/maple-labs/liquidations)
- [pool-permission-manager Repository](https://github.com/maple-labs/pool-permission-manager)
