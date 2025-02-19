import { Trade } from "@/types/trades";
import { cacheFetch, cacheRemove } from "./cache";
import { startOfYear, format } from "date-fns";
import type {
  SchwabAccount,
  SchwabQuoteResponse,
  ParsedPosition,
  ParsedPortfolio,
  PriceDataPoint,
  PriceHistoryParams,
  PriceHistoryResponse,
} from "@/types/schwab";

function parseSchwabAccounts(data: SchwabAccount[]): ParsedPortfolio[] {
  if (!data || !data.length) {
    return [];
  }

  return data.map((account) => {
    const positions = account.securitiesAccount.positions || [];

    const parsedPositions: ParsedPosition[] = positions
      .filter((pos) => pos.longQuantity > 0 || pos.shortQuantity > 0) // Filter out zero-quantity positions
      .map((position) => {
        const quantity = position.longQuantity - position.shortQuantity;

        return {
          symbol:
            position.instrument.assetType === "EQUITY"
              ? position.instrument.symbol
              : position.instrument.symbol.split(" ")[0],
          name: position.instrument.description || position.instrument.symbol,
          amount: quantity,
          priceUsd: position.averagePrice.toFixed(2),
          value: position.marketValue,
          changePercent24Hr: position.currentDayProfitLossPercentage.toFixed(2),
          id: position.instrument.cusip,
          type: "stock" as const,
        };
      });

    return {
      accountNumber: account.securitiesAccount.accountNumber,
      positions: parsedPositions,
      liquidationValue:
        account.securitiesAccount.currentBalances.liquidationValue,
      availableFunds: account.securitiesAccount.currentBalances.availableFunds,
      buyingPower: account.securitiesAccount.currentBalances.buyingPower,
      cashBalance: account.securitiesAccount.currentBalances.cashBalance,
    };
  });
}

// Helper function to format currency values
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

async function fetchSchwabApi<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getSchwabToken();
  const response = await fetch(`https://api.schwabapi.com${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      // delete cached and expired token from cache
      cacheRemove("schwab-token");
      throw new Error("Failed to fetch Schwab token");
    }
    throw new Error(`Failed to fetch ${endpoint}: ${response.statusText}`);
  }

  return await response.json();
}

export async function fetchSchwabAccounts(): Promise<ParsedPortfolio[]> {
  return (
    (await cacheFetch<ParsedPortfolio[]>(
      "schwab-accounts",
      async () => {
        const data: SchwabAccount[] = await fetchSchwabApi(
          "/trader/v1/accounts?fields=positions",
        );
        return parseSchwabAccounts(data);
      },
      60, // 1 minute
    )) || []
  );
}

export async function getSchwabToken(): Promise<string | null> {
  return await cacheFetch<string>(
    "schwab-token",
    async () => {
      if (import.meta.env.PROD) {
        const response = await fetch(
          "https://huskly.finance/schwab/oauth/token",
          { method: "GET", credentials: "include" },
        );
        if (!response.ok) {
          throw new Error("Failed to fetch Schwab token");
        }
        const { token } = await response.json();
        return token;
      } else {
        // allow overriding oauth token for local development
        return import.meta.env.VITE_SCHWAB_TOKEN;
      }
    },
    900, // 15 minutes
  );
}

export async function fetchAccountNumbers(): Promise<
  { accountNumber: string; hashValue: string }[]
> {
  return (
    (await cacheFetch<{ accountNumber: string; hashValue: string }[]>(
      "schwab-account-numbers",
      async () => await fetchSchwabApi("/trader/v1/accounts/accountNumbers"),
      60 * 60 * 12, // 12 hours
    )) || []
  );
}

export async function fetchTransactionHistory(
  startDate: Date = startOfYear(new Date()),
  endDate: Date = new Date(),
): Promise<{ accountNumber: string; transactions: Trade[] }[]> {
  const accountNumbers = await fetchAccountNumbers();
  const transactionHistory = await Promise.all(
    accountNumbers.map((account) =>
      fetchAccountTransactionHistory(account.hashValue, startDate, endDate),
    ),
  );
  return transactionHistory.map((transactions, index) => ({
    accountNumber: accountNumbers[index].accountNumber,
    transactions,
  }));
}

export async function fetchAccountTransactionHistory(
  accountHash: string,
  startDate: Date = startOfYear(new Date()),
  endDate: Date = new Date(),
): Promise<Trade[]> {
  const formattedStartDate = format(startDate, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  const formattedEndDate = format(endDate, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  return await fetchSchwabApi(
    `/trader/v1/accounts/${accountHash}/transactions?startDate=${formattedStartDate}&endDate=${formattedEndDate}`,
  );
}

export async function fetchSchwabQuotes(
  symbols: string[],
): Promise<SchwabQuoteResponse> {
  const symbolList = symbols.join(",");
  return await fetchSchwabApi(
    `/marketdata/v1/quotes?symbols=${symbolList}&fields=quote%2Creference&indicative=false`,
  );
}

export async function fetchSchwabPriceHistory(
  symbol: string,
  days: number,
  frequency: number,
  frequencyType: "minute" | "daily" | "weekly" | "monthly",
): Promise<PriceDataPoint[]> {
  const periodType =
    days <= 1
      ? "day"
      : days <= 10
        ? "day"
        : days <= 180
          ? "month"
          : days <= 365
            ? "year"
            : "year";
  const period =
    days <= 1
      ? 1
      : days <= 10
        ? days
        : days <= 180
          ? Math.ceil(days / 30)
          : days <= 365
            ? 1
            : 5;
  const endDate = Date.now();
  const params: PriceHistoryParams = {
    symbol,
    periodType,
    period,
    frequencyType,
    frequency,
    endDate,
    needExtendedHoursData: days <= 1,
  };

  const queryString = Object.entries(params)
    .filter(([_, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  const data = await fetchSchwabApi<PriceHistoryResponse>(
    `/marketdata/v1/pricehistory?${queryString}`,
  );

  if (data.empty) {
    return [];
  }

  return (
    data.candles
      .map(({ datetime, close }) => ({ timestamp: datetime, price: close }))
      .sort((a, b) => a.timestamp - b.timestamp)
      // Filter out duplicates, keeping first occurrence if any
      .filter(
        (candle, index, array) =>
          array.findIndex((c) => c.timestamp === candle.timestamp) === index,
      )
  );
}
