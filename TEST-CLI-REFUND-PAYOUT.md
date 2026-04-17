# CLI 退款 & Payout 扩展 — 测试文档

## 前置条件

```bash
# 1. 构建
npm run build

# 2. 确认 agent 已初始化（需要有效 JWT）
node dist/cli.js status

# 如果未初始化：
node dist/cli.js init --name "Test Agent" --client "CLI Test"
```

> 以下所有命令均可在项目根目录使用 `node dist/cli.js` 执行，或使用编译后的 `fluxa-wallet`。

---

## 一、Payout 扩展测试

### 1.1 向后兼容 — 原有参数不受影响

```bash
# 最小必填参数（应正常发起，等待审批）
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_001

# 预期: success=true, status=pending_authorization, approvalUrl 非空
```

### 1.2 缺少必填参数

```bash
# 缺 --to
node dist/cli.js payout --amount 1000000 --id pay_test_002
# 预期: success=false, error 包含 "Missing required parameters"

# 缺 --amount
node dist/cli.js payout --to 0x1234567890abcdef1234567890abcdef12345678 --id pay_test_003
# 预期: success=false, error 包含 "Missing required parameters"

# 缺 --id
node dist/cli.js payout --to 0x1234567890abcdef1234567890abcdef12345678 --amount 1000000
# 预期: success=false, error 包含 "Missing required parameters"
```

### 1.3 参数校验

```bash
# 地址格式错误
node dist/cli.js payout --to 0xBAD --amount 1000000 --id pay_test_004
# 预期: success=false, error="Invalid recipient address format"

# amount 非数字
node dist/cli.js payout --to 0x1234567890abcdef1234567890abcdef12345678 --amount abc --id pay_test_005
# 预期: success=false, error="Amount must be a positive integer (smallest units)"
```

### 1.4 使用 --mandate（自动审批）

```bash
# 需要先创建一个已签署的 mandate
node dist/cli.js mandate-create --desc "Test payout mandate" --amount 10000000

# 用返回的 mandateId 发起 payout
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_mandate_001 \
  --mandate <mandateId>

# 预期: success=true, status=authorized（跳过审批），approvalUrl=null
```

### 1.5 使用 --biz-id（业务去重）

```bash
# 首次创建
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_biz_001 \
  --biz-id order_001

# 预期: success=true, bizId="order_001"

# 相同 biz-id 再次创建（不同 payoutId）
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_biz_002 \
  --biz-id order_001

# 预期: success=false, 后端返回 409（bizId 已被占用）
```

### 1.6 使用 --description

```bash
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_desc_001 \
  --description "Payment for invoice #12345"

# 预期: success=true，创建成功
```

### 1.7 三个新参数组合使用

```bash
node dist/cli.js payout \
  --to 0x1234567890abcdef1234567890abcdef12345678 \
  --amount 1000000 \
  --id pay_test_combo_001 \
  --mandate <mandateId> \
  --biz-id order_combo_001 \
  --description "Combo test payout"

# 预期: success=true, status=authorized, bizId="order_combo_001"
```

### 1.8 帮助文本

```bash
node dist/cli.js payout --help
# 预期: 显示包含 --mandate、--biz-id、--description 的完整帮助
```

---

## 二、Payment Link Refund 测试

> 退款测试需要先有一笔通过 payment link 收到的 **已结算（settled）** 付款记录。

### 2.0 准备测试数据

```bash
# 创建 payment link
node dist/cli.js paymentlink-create --amount 1000000 --desc "Refund test link"
# 记录返回的 linkId

# 用返回的 URL 完成一笔付款（在浏览器中操作，或让另一个 agent 付款）

# 查看 payment link 下的付款记录
node dist/cli.js paymentlink-payments --id <linkId>
# 记录返回的 payment record id（用于退款的 --payment-id）

# 也可以用 received-records 查看
node dist/cli.js received-records --limit 5
```

### 2.1 发起全额退款

```bash
node dist/cli.js paymentlink-refund-create --payment-id <paymentId>

# 预期: success=true
# 响应包含: refundId, refundUrl, status="pending", amount=原始金额
```

### 2.2 发起部分退款

```bash
node dist/cli.js paymentlink-refund-create \
  --payment-id <paymentId> \
  --amount 500000 \
  --reason "Partial refund - item returned"

# 预期: success=true, amount="500000"
```

### 2.3 缺少必填参数

```bash
# 没有 --payment-id
node dist/cli.js paymentlink-refund-create
# 预期: success=false, error="Missing required parameter: --payment-id"
```

### 2.4 参数校验

```bash
# payment-id 非数字
node dist/cli.js paymentlink-refund-create --payment-id abc
# 预期: success=false, error="Invalid payment ID: must be a number"

# amount 非数字
node dist/cli.js paymentlink-refund-create --payment-id 1 --amount abc
# 预期: success=false, error="Amount must be a positive integer (atomic units)"
```

### 2.5 错误场景

```bash
# 不存在的 payment-id
node dist/cli.js paymentlink-refund-create --payment-id 999999
# 预期: success=false, 后端返回 404

# 退款金额超过原始金额
node dist/cli.js paymentlink-refund-create --payment-id <paymentId> --amount 99999999999
# 预期: success=false, 后端返回 400
```

### 2.6 查询退款列表

```bash
# 默认分页
node dist/cli.js paymentlink-refund-list
# 预期: success=true, data 包含 refunds 数组

# 指定分页
node dist/cli.js paymentlink-refund-list --limit 5 --offset 0
# 预期: success=true, refunds 数组最多 5 条
```

### 2.7 查询单笔退款详情

```bash
node dist/cli.js paymentlink-refund-get --id <refundId>
# 预期: success=true, data 包含完整退款信息
#   refundId, refundUrl, paymentId, status, amount, currency, etc.
```

```bash
# 缺少 --id
node dist/cli.js paymentlink-refund-get
# 预期: success=false, error="Missing required parameter: --id"

# id 非数字
node dist/cli.js paymentlink-refund-get --id abc
# 预期: success=false, error="Invalid refund ID: must be a number"

# 不存在的 refund id
node dist/cli.js paymentlink-refund-get --id 999999
# 预期: success=false, 后端返回 404
```

### 2.8 取消退款

```bash
# 先创建一笔退款（状态为 pending）
node dist/cli.js paymentlink-refund-create --payment-id <paymentId>
# 记录 refundId

# 取消该退款
node dist/cli.js paymentlink-refund-cancel --id <refundId>
# 预期: success=true, status="cancelled"
```

```bash
# 缺少 --id
node dist/cli.js paymentlink-refund-cancel
# 预期: success=false, error="Missing required parameter: --id"

# 取消已结算的退款（应失败）
node dist/cli.js paymentlink-refund-cancel --id <settledRefundId>
# 预期: success=false, 后端返回 410
```

### 2.9 帮助文本

```bash
node dist/cli.js paymentlink-refund-create --help
node dist/cli.js paymentlink-refund-list --help
node dist/cli.js paymentlink-refund-get --help
node dist/cli.js paymentlink-refund-cancel --help
# 预期: 每个命令都显示完整的用法说明
```

---

## 三、回归测试

确保已有功能未受影响：

```bash
# Agent 状态
node dist/cli.js status

# Payment link CRUD
node dist/cli.js paymentlink-list --limit 3
node dist/cli.js paymentlink-create --amount 100000 --desc "Regression test"
node dist/cli.js paymentlink-get --id <linkId>
node dist/cli.js paymentlink-delete --id <linkId>

# 收款记录
node dist/cli.js received-records --limit 3

# Payout 状态查询
node dist/cli.js payout-status --id <existingPayoutId>

# 全局帮助
node dist/cli.js --help
# 预期: 包含 paymentlink-refund-* 四条新命令
```

---

## 四、测试检查清单

| # | 测试项 | 命令 | 预期结果 | 通过 |
|---|--------|------|----------|------|
| 1 | Payout 向后兼容 | `payout --to --amount --id` | 正常创建 | ☐ |
| 2 | Payout 缺参数 | `payout`（无参数） | 报错缺必填 | ☐ |
| 3 | Payout 地址校验 | `payout --to 0xBAD ...` | 报错格式错 | ☐ |
| 4 | Payout --mandate | `payout ... --mandate mand_xxx` | status=authorized | ☐ |
| 5 | Payout --biz-id 首次 | `payout ... --biz-id order_001` | 成功 | ☐ |
| 6 | Payout --biz-id 重复 | 相同 biz-id 不同 payoutId | 409 报错 | ☐ |
| 7 | Payout --description | `payout ... --description "..."` | 成功 | ☐ |
| 8 | Payout help | `payout --help` | 含新参数 | ☐ |
| 9 | Refund 全额创建 | `paymentlink-refund-create --payment-id X` | 成功 | ☐ |
| 10 | Refund 部分创建 | `... --amount 500000 --reason "..."` | 成功 | ☐ |
| 11 | Refund 缺 payment-id | `paymentlink-refund-create` | 报错缺参数 | ☐ |
| 12 | Refund payment-id 非数字 | `... --payment-id abc` | 报错 | ☐ |
| 13 | Refund amount 非数字 | `... --payment-id 1 --amount abc` | 报错 | ☐ |
| 14 | Refund 列表 | `paymentlink-refund-list` | 返回数组 | ☐ |
| 15 | Refund 列表分页 | `... --limit 5 --offset 0` | ≤5 条 | ☐ |
| 16 | Refund 详情 | `paymentlink-refund-get --id X` | 返回详情 | ☐ |
| 17 | Refund 详情缺 id | `paymentlink-refund-get` | 报错缺参数 | ☐ |
| 18 | Refund 取消 | `paymentlink-refund-cancel --id X` | status=cancelled | ☐ |
| 19 | Refund 取消已结算 | `paymentlink-refund-cancel --id X` | 410 报错 | ☐ |
| 20 | Refund help ×4 | 四个子命令 --help | 正确输出 | ☐ |
| 21 | 全局 help | `--help` | 含 refund 命令 | ☐ |
| 22 | 回归: paymentlink-list | `paymentlink-list` | 正常 | ☐ |
| 23 | 回归: received-records | `received-records` | 正常 | ☐ |
| 24 | 回归: payout-status | `payout-status --id X` | 正常 | ☐ |
