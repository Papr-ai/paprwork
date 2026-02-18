---
id: preloaded-yahoo-finance
name: Yahoo Finance
description: Access financial data — stock prices, company financials, market data, and analysis using yfinance (zero API key).
---
# Yahoo Finance

Access financial market data using the `yfinance` Python library. No API key required.

## Setup

```bash
pip install yfinance
```

## Quick Commands

### Stock Price
```python
import yfinance as yf

ticker = yf.Ticker("AAPL")
info = ticker.info
print(f"Price: ${info['currentPrice']}")
print(f"Market Cap: ${info['marketCap']:,}")
print(f"P/E Ratio: {info['trailingPE']:.2f}")
```

### Historical Data
```python
# Last 30 days
hist = ticker.history(period="1mo")
print(hist[['Open', 'High', 'Low', 'Close', 'Volume']])

# Custom date range
hist = ticker.history(start="2025-01-01", end="2026-01-01")

# Different intervals
hist = ticker.history(period="5d", interval="1h")  # Hourly for 5 days
```

### Company Financials
```python
# Income statement
income = ticker.income_stmt
print(income.loc[['Total Revenue', 'Net Income']])

# Balance sheet
balance = ticker.balance_sheet

# Cash flow
cashflow = ticker.cashflow

# Quarterly data
quarterly_income = ticker.quarterly_income_stmt
```

### Multiple Tickers
```python
tickers = yf.Tickers("AAPL MSFT GOOGL AMZN")
for name, ticker in tickers.tickers.items():
    info = ticker.info
    print(f"{name}: ${info.get('currentPrice', 'N/A')}")
```

## Common Use Cases

### Portfolio Tracker Job
Create a job that tracks a portfolio and stores daily values in SQLite:

```python
import yfinance as yf
import sqlite3
from datetime import date

PORTFOLIO = {"AAPL": 50, "MSFT": 30, "GOOGL": 20}
conn = sqlite3.connect("data.db")

total = 0
for symbol, shares in PORTFOLIO.items():
    price = yf.Ticker(symbol).info.get('currentPrice', 0)
    value = price * shares
    total += value
    conn.execute(
        "INSERT INTO portfolio (date, symbol, shares, price, value) VALUES (?,?,?,?,?)",
        (date.today().isoformat(), symbol, shares, price, value)
    )

conn.execute(
    "INSERT INTO portfolio_total (date, total_value) VALUES (?,?)",
    (date.today().isoformat(), total)
)
conn.commit()
```

### Market Research
```python
# Compare P/E ratios across sector
sector_tickers = ["AAPL", "MSFT", "GOOGL", "META", "AMZN"]
for sym in sector_tickers:
    info = yf.Ticker(sym).info
    print(f"{sym}: P/E={info.get('trailingPE', 'N/A')}, Market Cap={info.get('marketCap', 0):,}")
```

### Price Alerts Job
Monitor prices and deliver alerts when thresholds are crossed.

## Data Available

- Current price, volume, market cap
- Historical OHLCV data (daily, weekly, monthly, hourly)
- Income statements, balance sheets, cash flow
- Analyst recommendations
- Dividend history
- Options chains
- Institutional holders
- News headlines

## Limitations

- Data may be delayed 15-20 minutes
- Rate limits apply (space requests 1-2 seconds apart)
- Not suitable for real-time trading
- Free tier only (no premium Yahoo Finance data)

## Integration with Papr

- Create jobs to track portfolio daily
- Build mini-app dashboards for market overview
- Store historical data in SQLite for trend analysis
- Set up price alert jobs with chat delivery
