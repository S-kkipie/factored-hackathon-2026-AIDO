# Data quality report

Run: `20261003T154212-38e8901a`

## Load summary (this run)

| table | files_loaded | rows_read | rejected | duplicates_in_batch | inserted | updated | missing_columns | unexpected_columns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| customers | 0 | 0 | 0 | 0 | 0 | 0 | - | - |
| products | 0 | 0 | 0 | 0 | 0 | 0 | - | - |
| transactions | 0 | 0 | 0 | 0 | 0 | 0 | - | - |
| complaints | 0 | 0 | 0 | 0 | 0 | 0 | - | - |
| call_center_interactions | 0 | 0 | 0 | 0 | 0 | 0 | - | - |

## customers

- Staged rows: 150000 (documented: 150000, delta: 0.0%)
- Content-level duplicates (same values, different key): 0

### Rejects by reason

_none_

### Null rates (nullable columns, %)

| column | pct |
| --- | --- |
| detected_accent | 29.88 |

### Orphaned foreign keys

_none_

## products

- Staged rows: 400000 (documented: 400000, delta: 0.0%)
- Content-level duplicates (same values, different key): 0

### Rejects by reason

_none_

### Null rates (nullable columns, %)

| column | pct |
| --- | --- |
| credit_limit | 68.67 |

### Orphaned foreign keys

| column | references | n |
| --- | --- | --- |
| customer_id | customers.customer_id | 0 |

## transactions

- Staged rows: 4425008 (documented: 5000000, delta: -11.5%)
- Content-level duplicates (same values, different key): 0
- Arrival lag (process_date - event date, days): avg -0.25, min -1, max 0

### Rejects by reason

_none_

### Null rates (nullable columns, %)

| column | pct |
| --- | --- |
| transaction_category | 60.87 |
| amount_usd | 57.34 |
| merchant_name | 76.74 |
| merchant_category | 76.75 |
| transaction_city | 10 |
| response_code | 5 |
| fraud_score | 20 |

### Orphaned foreign keys

| column | references | n |
| --- | --- | --- |
| product_id | products.product_id | 0 |
| customer_id | customers.customer_id | 0 |

## complaints

- Staged rows: 67095 (documented: 80000, delta: -16.1%)
- Content-level duplicates (same values, different key): 0
- Arrival lag (process_date - event date, days): avg -0.34, min -1, max 0

### Rejects by reason

_none_

### Null rates (nullable columns, %)

| column | pct |
| --- | --- |
| subcategory | 9.98 |
| affected_product_id | 33.57 |
| claimed_amount | 67.58 |
| currency | 67.54 |
| resolution_days | 77.1 |
| resolution_satisfaction | 96.3 |

### Orphaned foreign keys

| column | references | n |
| --- | --- | --- |
| customer_id | customers.customer_id | 0 |
| affected_product_id | products.product_id | 0 |

## call_center_interactions

- Staged rows: 686296 (documented: 800000, delta: -14.2%)
- Content-level duplicates (same values, different key): 0
- Arrival lag (process_date - event date, days): avg -0.33, min -1, max 0

### Rejects by reason

_none_

### Null rates (nullable columns, %)

| column | pct |
| --- | --- |
| duration_seconds | 14.02 |
| wait_time_seconds | 29.96 |
| was_resolved | 0 |
| detected_sentiment | 0 |

### Orphaned foreign keys

| column | references | n |
| --- | --- | --- |
| customer_id | customers.customer_id | 0 |
