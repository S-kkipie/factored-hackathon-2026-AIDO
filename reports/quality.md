# Data quality report

Run: `20261003T155844-c6946f75`

## Load summary (all runs)

| table | files_loaded | rows_read | rejected | duplicates_in_batch | inserted | updated | missing_columns | unexpected_columns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| call_center_interactions | 1097 | 686296 | 0 | 0 | 686296 | 0 | - | agent_id, interaction_type, contact_reason, requires_followup, sentiment_score, customer_detected_accent, agent_used_accent, mentioned_products, has_transcript, has_recording |
| complaints | 1097 | 67095 | 0 | 0 | 67095 | 0 | - | related_branch_id, origin_interaction_id, assigned_agent_id, assignment_date, first_response_date, resolution_date, closing_date, resolution, compensation_granted |
| customers | 1 | 150000 | 0 | 0 | 150000 | 0 | - | document_number, date_of_birth, gender, email, mobile_phone, landline_phone, address, city, state, postal_code, credit_score, estimated_monthly_income, occupation, marital_status, education_level, registration_branch_id, accepts_marketing |
| products | 1 | 400000 | 0 | 0 | 400000 | 0 | - | interest_rate, expiration_date, opening_branch_id, opening_channel, has_linked_app, days_past_due, last_transaction_date |
| transactions | 1097 | 4425008 | 0 | 0 | 4425008 | 0 | - | branch_id, latitude, longitude |

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
