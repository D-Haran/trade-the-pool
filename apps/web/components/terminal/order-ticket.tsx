'use client';

import { MARKET_REGISTRY, allowedLeverages } from '@trade-the-pool/shared';
import type {
  EntryDetailDto,
  MarketSnapshotDto,
  MarketSymbolDto,
  ProfessionalOrderRequestDto,
} from '@trade-the-pool/shared';
import { Info, Keyboard, Settings2, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPrice, formatUsd } from '@/lib/format';
import { useTerminalStore } from '@/lib/terminal-store';
import { marginFromPositionSize, positionSizeFromMargin } from '@/lib/order-sizing';
import { Button } from '../ui/button';

type PositionSide = 'LONG' | 'SHORT';
type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET';
type SizingMode = 'MARGIN' | 'POSITION_SIZE';
const percentages = [2500, 5000, 7500, 10_000] as const;

function validPositive(value: string, places: number): boolean {
  return new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(value) && !/^0+(?:\.0+)?$/.test(value);
}

export function OrderTicket({
  account,
  symbol,
  market,
  disabled,
  disabledReason,
  pending,
  onSubmit,
}: {
  account: EntryDetailDto;
  symbol: MarketSymbolDto;
  market?: MarketSnapshotDto;
  disabled: boolean;
  disabledReason: string | null;
  pending: boolean;
  onSubmit: (body: ProfessionalOrderRequestDto) => void;
}) {
  const [positionSide, setPositionSide] = useState<PositionSide>('LONG');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [sizingMode, setSizingMode] = useState<SizingMode>('MARGIN');
  const [sizeAmount, setSizeAmount] = useState('500.00');
  const [leverage, setLeverage] = useState(1);
  const [orderPrice, setOrderPrice] = useState('');
  const [riskOpen, setRiskOpen] = useState(false);
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { hotkeysEnabled, confirmationsEnabled, setHotkeysEnabled, setConfirmationsEnabled } =
    useTerminalStore();

  const availableMargin = Number(account.availableMargin);
  const buyingPower = Math.max(0, availableMargin * leverage);
  const validSize = validPositive(sizeAmount, 2);
  const positionSize = validSize
    ? sizingMode === 'MARGIN'
      ? positionSizeFromMargin(sizeAmount, leverage)
      : sizeAmount
    : '0.00';
  const marginRequired = validSize
    ? sizingMode === 'MARGIN'
      ? sizeAmount
      : marginFromPositionSize(sizeAmount, leverage)
    : '0.00';
  const estimatedFee = Number(positionSize) * 0.001;
  const estimatedMargin = Number(marginRequired);
  const availableAfter = Math.max(0, availableMargin - estimatedMargin - estimatedFee);
  const mark = Number(market?.markPrice ?? market?.price ?? '0');
  const estimatedLiquidation =
    mark > 0
      ? positionSide === 'LONG'
        ? Math.max(0, mark * (1 - 0.8 / leverage))
        : mark * (1 + 0.8 / leverage)
      : null;
  const invalid =
    !validSize ||
    estimatedMargin + estimatedFee > availableMargin ||
    (orderType !== 'MARKET' && !validPositive(orderPrice, 8)) ||
    (takeProfitPrice.length > 0 && !validPositive(takeProfitPrice, 8)) ||
    (stopLossPrice.length > 0 && !validPositive(stopLossPrice, 8));

  const presets = useMemo(
    () =>
      percentages.map((percentage) =>
        (((sizingMode === 'MARGIN' ? availableMargin : buyingPower) * percentage) / 10_000).toFixed(
          2,
        ),
      ),
    [availableMargin, buyingPower, sizingMode],
  );

  useEffect(() => {
    if (!hotkeysEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key.toLowerCase() === 'b') setPositionSide('LONG');
      if (event.key.toLowerCase() === 's') setPositionSide('SHORT');
      if (event.key === 'Escape') setConfirming(false);
      const preset = Number(event.key) - 1;
      if (preset >= 0 && preset < presets.length) setSizeAmount(presets[preset]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeysEnabled, presets]);

  useEffect(() => {
    setConfirming(false);
    setOrderPrice('');
    setRiskOpen(false);
    setTakeProfitPrice('');
    setStopLossPrice('');
    setLeverage((current) => Math.min(current, MARKET_REGISTRY[symbol].maxLeverage));
  }, [symbol, account.id]);

  const submit = () => {
    if (invalid || disabled || pending) return;
    if (confirmationsEnabled && !confirming) {
      setConfirming(true);
      return;
    }
    const execution =
      orderType === 'MARKET'
        ? ({ type: 'MARKET' } as const)
        : orderType === 'LIMIT'
          ? ({ type: 'LIMIT', limitPrice: orderPrice } as const)
          : ({ type: 'STOP_MARKET', stopPrice: orderPrice } as const);
    onSubmit({
      entryId: account.id,
      symbol,
      intent: 'OPEN',
      positionSide,
      sizing: { type: sizingMode, amount: sizeAmount },
      leverage,
      execution,
      ...(takeProfitPrice ? { takeProfitPrice } : {}),
      ...(stopLossPrice ? { stopLossPrice } : {}),
    });
    setConfirming(false);
  };

  return (
    <aside className="professional-order-ticket">
      <div className="ticket-account-context">
        <div>
          <span>{account.tournament.name}</span>
          <strong>ENTRY #{account.sequenceNumber}</strong>
        </div>
        <b>PAPER</b>
        <button onClick={() => setSettingsOpen((value) => !value)} aria-label="Order settings">
          <Settings2 aria-hidden="true" />
        </button>
      </div>
      {settingsOpen ? (
        <div className="ticket-settings">
          <label>
            <input
              type="checkbox"
              checked={confirmationsEnabled}
              onChange={(event) => setConfirmationsEnabled(event.target.checked)}
            />
            Confirm order submission
          </label>
          <label>
            <input
              type="checkbox"
              checked={hotkeysEnabled}
              onChange={(event) => setHotkeysEnabled(event.target.checked)}
            />
            Enable trading hotkeys
          </label>
          <small>B/S side · 1–4 size · Esc cancel</small>
        </div>
      ) : null}

      <div className="direction-tabs">
        <button
          className={positionSide === 'LONG' ? 'is-active is-long' : ''}
          onClick={() => setPositionSide('LONG')}
        >
          BUY / LONG <kbd>B</kbd>
        </button>
        <button
          className={positionSide === 'SHORT' ? 'is-active is-short' : ''}
          onClick={() => setPositionSide('SHORT')}
        >
          SHORT <kbd>S</kbd>
        </button>
      </div>

      <div className="order-type-tabs" aria-label="Order type">
        {(['MARKET', 'LIMIT', 'STOP_MARKET'] as OrderType[]).map((type) => (
          <button
            key={type}
            className={type === orderType ? 'is-active' : ''}
            onClick={() => {
              setOrderType(type);
              setConfirming(false);
            }}
          >
            {type === 'STOP_MARKET' ? 'Stop' : type[0] + type.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <div className="leverage-control">
        <div>
          <span>LEVERAGE</span>
          <small>Market cap {MARKET_REGISTRY[symbol].maxLeverage}x</small>
        </div>
        <div role="group" aria-label="Leverage">
          {allowedLeverages(symbol).map((value) => (
            <button
              key={value}
              className={value === leverage ? 'is-active' : ''}
              onClick={() => {
                setLeverage(value);
                setConfirming(false);
              }}
            >
              {value}x
            </button>
          ))}
        </div>
      </div>

      <div className="sizing-mode-toggle" role="group" aria-label="Order sizing mode">
        <button
          className={sizingMode === 'MARGIN' ? 'is-active' : ''}
          onClick={() => setSizingMode('MARGIN')}
        >
          Margin
        </button>
        <button
          className={sizingMode === 'POSITION_SIZE' ? 'is-active' : ''}
          onClick={() => setSizingMode('POSITION_SIZE')}
        >
          Position Size
        </button>
      </div>

      <label className="terminal-field">
        <span>{sizingMode === 'MARGIN' ? 'MARGIN' : 'POSITION SIZE'}</span>
        <div>
          <i>$</i>
          <input
            value={sizeAmount}
            onChange={(event) => {
              setSizeAmount(event.target.value);
              setConfirming(false);
            }}
            inputMode="decimal"
            aria-label={sizingMode === 'MARGIN' ? 'Margin amount in USD' : 'Position size in USD'}
          />
          <b>USD</b>
        </div>
      </label>
      <div className="ticket-presets">
        {presets.map((value, index) => (
          <button key={percentages[index]} onClick={() => setSizeAmount(value)}>
            {percentages[index] / 100}% <kbd>{index + 1}</kbd>
          </button>
        ))}
      </div>

      {orderType !== 'MARKET' ? (
        <label className="terminal-field">
          <span>{orderType === 'LIMIT' ? 'LIMIT PRICE' : 'STOP TRIGGER'}</span>
          <div>
            <i>$</i>
            <input
              value={orderPrice}
              onChange={(event) => setOrderPrice(event.target.value)}
              placeholder={market?.price ?? '0.00'}
              inputMode="decimal"
              aria-label={orderType === 'LIMIT' ? 'Limit price' : 'Stop trigger price'}
            />
            <b>USD</b>
          </div>
        </label>
      ) : null}

      <button className="risk-toggle" onClick={() => setRiskOpen((value) => !value)}>
        <ShieldCheck aria-hidden="true" /> Take Profit / Stop Loss
        <span>{riskOpen ? 'Hide' : 'Add'}</span>
      </button>
      {riskOpen ? (
        <div className="risk-fields">
          <label className="terminal-field terminal-field--compact">
            <span>TAKE PROFIT</span>
            <div>
              <i>$</i>
              <input
                value={takeProfitPrice}
                onChange={(event) => setTakeProfitPrice(event.target.value)}
                placeholder="Optional"
                inputMode="decimal"
              />
            </div>
          </label>
          <label className="terminal-field terminal-field--compact">
            <span>STOP LOSS</span>
            <div>
              <i>$</i>
              <input
                value={stopLossPrice}
                onChange={(event) => setStopLossPrice(event.target.value)}
                placeholder="Optional"
                inputMode="decimal"
              />
            </div>
          </label>
        </div>
      ) : null}

      <div className="position-size-preview">
        <span>POSITION SIZE</span>
        <strong className="tabular">{formatUsd(positionSize)}</strong>
        <small>
          {leverage}x leverage · {formatUsd(marginRequired)} margin
        </small>
      </div>
      <dl className="order-estimate order-estimate--primary">
        <div>
          <dt>Margin required</dt>
          <dd className="tabular">{formatUsd(marginRequired)}</dd>
        </div>
        <div>
          <dt>Exposure</dt>
          <dd className="tabular">{formatUsd(positionSize)}</dd>
        </div>
        <div>
          <dt>Available after trade</dt>
          <dd className="tabular">~{formatUsd(availableAfter.toFixed(2))}</dd>
        </div>
        <div>
          <dt>Est. liquidation</dt>
          <dd className="tabular">
            {estimatedLiquidation && leverage > 1
              ? `~${formatPrice(estimatedLiquidation.toFixed(8), symbol)}`
              : '—'}
          </dd>
        </div>
      </dl>
      <dl className="order-estimate order-estimate--secondary">
        <div>
          <dt>Reference mark</dt>
          <dd className="tabular">
            {market?.markPrice ? formatPrice(market.markPrice, symbol) : '—'}
          </dd>
        </div>
        <div>
          <dt>Estimated fee</dt>
          <dd className="tabular">~{formatUsd(estimatedFee.toFixed(2))}</dd>
        </div>
        <div>
          <dt>Available margin</dt>
          <dd className="tabular">{formatUsd(account.availableMargin)}</dd>
        </div>
        <div>
          <dt>{leverage}x order capacity</dt>
          <dd className="tabular">{formatUsd(buyingPower.toFixed(2))}</dd>
        </div>
      </dl>

      {disabledReason ? (
        <p className="ticket-blocked" role="status">
          <Info aria-hidden="true" /> {disabledReason}
        </p>
      ) : null}
      <Button
        className={cn('professional-submit', positionSide === 'SHORT' && 'is-short')}
        disabled={disabled || invalid || pending}
        onClick={submit}
      >
        {pending
          ? 'Submitting…'
          : confirming
            ? `Confirm ${positionSide} ${symbol.split('-')[0]}`
            : `${orderType === 'MARKET' ? 'Place' : 'Create'} ${positionSide} order`}
      </Button>
      <p className="paper-disclaimer">
        Simulated order. No real asset will be purchased. Final fills use authoritative server
        pricing.
      </p>
      {hotkeysEnabled ? (
        <span className="hotkey-hint">
          <Keyboard aria-hidden="true" /> Hotkeys enabled
        </span>
      ) : null}
    </aside>
  );
}
