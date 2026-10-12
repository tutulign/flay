import { afterEach, describe, expect, it, vi } from 'vitest';
import { JUP_MINT, SOL_MINT, USDC_MINT } from '../shared/constants.js';
import { TokenService } from './tokens.js';

afterEach(() => vi.unstubAllGlobals());

describe('core token metadata', () => {
  it('keeps canonical metadata while hydrating missing SOL and JUP prices in one live request', async () => {
    const providerFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe('/price/v3');
      expect(new Set((url.searchParams.get('ids') ?? '').split(','))).toEqual(new Set([SOL_MINT, JUP_MINT]));
      return new Response(JSON.stringify({
        [SOL_MINT]: { usdPrice: 110.25 },
        [JUP_MINT]: { usdPrice: 0.52 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', providerFetch);
    const service = new TokenService();
    const tokens = await Promise.all([SOL_MINT, USDC_MINT, JUP_MINT].map((mint) => service.getByMint(mint)));
    expect(tokens.map((token) => token.symbol)).toEqual(['SOL', 'USDC', 'JUP']);
    expect(tokens.map((token) => token.decimals)).toEqual([9, 6, 6]);
    expect(tokens.map((token) => token.usdPrice)).toEqual([110.25, 1, 0.52]);
    expect(tokens.every((token) => token.verified && token.tradable)).toBe(true);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed with canonical identity intact when live core pricing is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const token = await new TokenService().getByMint(SOL_MINT);
    expect(token).toMatchObject({ mint: SOL_MINT, symbol: 'SOL', verified: true, tradable: true, usdPrice: null });
  });
});

describe('Jupiter token metadata batching', () => {
  it('combines simultaneous mint metadata reads into one provider request', async () => {
    const providerFetch = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const ids = (url.searchParams.get('query') ?? '').split(',').filter(Boolean);
      return new Response(JSON.stringify(ids.map((id) => ({ id, symbol: id.toUpperCase() }))), { status: 200 });
    });
    vi.stubGlobal('fetch', providerFetch);
    const service = new TokenService() as unknown as {
      fetchMetadata(mints: string[]): Promise<Map<string, { id: string; symbol?: string }>>;
    };

    const [first, second] = await Promise.all([
      service.fetchMetadata(['mint-a', 'mint-b']),
      service.fetchMetadata(['mint-b', 'mint-c']),
    ]);

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(first.get('mint-a')?.symbol).toBe('MINT-A');
    expect(second.get('mint-c')?.symbol).toBe('MINT-C');
  });
});

describe('official xStocks Token-2022 policy', () => {
  const mint = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
  const base = {
    mint,
    symbol: 'AAPLx',
    name: 'Apple xStock',
    decimals: 8,
    logoUri: null,
    tokenProgram: 'token-2022' as const,
    verified: true,
    tags: ['stocks'],
    extensions: ['ScaledUiAmountConfig', 'PermanentDelegate', 'DefaultAccountState', 'PausableConfig', 'ConfidentialTransferMint', 'TransferHook'],
    tradable: false,
    blockedReason: 'Blocked in Convert.',
    usdPrice: null,
  };

  it('allows the reviewed issuer controls only through the official-stock method', async () => {
    const service = new TokenService();
    vi.spyOn(service, 'getByMint').mockResolvedValue(base);
    const token = await service.getOfficialStockByMint(mint, { symbol: 'AAPLx', name: 'Apple xStock', logoUri: null, usdPrice: 200 });
    expect(token).toMatchObject({ tradable: true, blockedReason: null, usdPrice: 200, tokenProgram: 'token-2022' });
  });

  it('keeps unreviewed transfer-fee behavior blocked even for an official symbol', async () => {
    const service = new TokenService();
    vi.spyOn(service, 'getByMint').mockResolvedValue({ ...base, extensions: [...base.extensions, 'TransferFeeConfig'] });
    await expect(service.getOfficialStockByMint(mint, { symbol: 'AAPLx', name: 'Apple xStock', logoUri: null, usdPrice: 200 }))
      .rejects.toMatchObject({ code: 'XSTOCKS_MINT_UNSUPPORTED' });
  });
});
