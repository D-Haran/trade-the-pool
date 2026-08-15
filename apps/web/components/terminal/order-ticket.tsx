'use client';

import { MARKET_REGISTRY, allowedLeverages } from '@trade-the-pool/shared';
import type {
  EntryDetailDto,
  MarketSnapshotDto,
  MarketSymbolDto,
  PositionDto,
  ProfessionalOrderRequestDto,
} from '@trade-the-pool/shared';
import { Keyboard, Settings2, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPercent, formatPrice, formatQuantity, formatUsd, isPositive } from '@/lib/format';
import { useTerminalStore } from '@/lib/terminal-store';
import { marginFromPositionSize, positionSizeFromMargin } from '@/lib/order-sizing';
import { Button } from '../ui/button';
import { AssetIcon } from './asset-icon';

type PositionSide = 'LONG' | 'SHORT';
type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET';
type SizingMode = 'MARGIN' | 'POSITION_SIZE';
const percentages = [2500, 5000, 7500, 10_000] as const;

function validPositive(value: string, places: number): boolean {
  return new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(value) && !/^0+(?:\.0+)?$/.test(value);
}

function OrderTypeTabs({
  value,
  onChange,
}: {
  value: OrderType;
  onChange: (value: OrderType) => void;
}) {
  return (
    <div className="order-type-tabs" aria-label="Order type">
      {(['MARKET', 'LIMIT', 'STOP_MARKET'] as OrderType[]).map((type) => (
        <button
          key={type}
          className={type === value ? 'is-active' : ''}
          onClick={() => onChange(type)}
        >
          {type === 'STOP_MARKET' ? 'Stop' : type[0] + type.slice(1).toLowerCase()}
        </button>
      ))}
    </div>
  );
}

export function OrderTicket({
  account,
  symbol,
  market,
  position,
  disabled,
  pending,
  onSubmit,
}: {
  account: EntryDetailDto;
  symbol: MarketSymbolDto;
  market?: MarketSnapshotDto;
  position: PositionDto | null;
  disabled: boolean;
  pending: boolean;
  onSubmit: (body: ProfessionalOrderRequestDto) => void;
}) {
  const [positionSide, setPositionSide] = useState<PositionSide>('LONG');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [closeOrderType, setCloseOrderType] = useState<OrderType>('MARKET');
  const [closePercentage, setClosePercentage] = useState<(typeof percentages)[number]>(10_000);
  const [sizingMode, setSizingMode] = useState<SizingMode>('MARGIN');
  const [sizeAmount, setSizeAmount] = useState('500.00');
  const [leverage, setLeverage] = useState(1);
  const [orderPrice, setOrderPrice] = useState('');
  const [closePrice, setClosePrice] = useState('');
  const [riskOpen, setRiskOpen] = useState(false);
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ticketTab = useTerminalStore((state) => state.orderPanelTab);
  const setTicketTab = useTerminalStore((state) => state.setOrderPanelTab);
  const hotkeysEnabled = useTerminalStore((state) => state.hotkeysEnabled);
  const confirmationsEnabled = useTerminalStore((state) => state.confirmationsEnabled);
  const setHotkeysEnabled = useTerminalStore((state) => state.setHotkeysEnabled);
  const setConfirmationsEnabled = useTerminalStore((state) => state.setConfirmationsEnabled);

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
  const invalidOpen =
    !validSize ||
    estimatedMargin + estimatedFee > availableMargin ||
    (orderType !== 'MARKET' && !validPositive(orderPrice, 8)) ||
    (takeProfitPrice.length > 0 && !validPositive(takeProfitPrice, 8)) ||
    (stopLossPrice.length > 0 && !validPositive(stopLossPrice, 8));
  const invalidClose = !position || (closeOrderType !== 'MARKET' && !validPositive(closePrice, 8));

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
    if (!hotkeysEnabled || ticketTab !== 'ORDER') return;
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
  }, [hotkeysEnabled, presets, ticketTab]);

  useEffect(() => {
    setConfirming(false);
    setOrderPrice('');
    setClosePrice('');
    setClosePercentage(10_000);
    setRiskOpen(false);
    setTakeProfitPrice('');
    setStopLossPrice('');
    setLeverage((current) => Math.min(current, MARKET_REGISTRY[symbol].maxLeverage));
  }, [symbol, account.id]);

  const changeSizingMode = (next: SizingMode) => {
    if (next === sizingMode) return;
    if (validSize)
      setSizeAmount(
        next === 'POSITION_SIZE'
          ? positionSizeFromMargin(sizeAmount, leverage)
          : marginFromPositionSize(sizeAmount, leverage),
      );
    setSizingMode(next);
    setConfirming(false);
  };

  const openExecution =
    orderType === 'MARKET'
      ? ({ type: 'MARKET' } as const)
      : orderType === 'LIMIT'
        ? ({ type: 'LIMIT', limitPrice: orderPrice } as const)
        : ({ type: 'STOP_MARKET', stopPrice: orderPrice } as const);
  const closeExecution =
    closeOrderType === 'MARKET'
      ? ({ type: 'MARKET' } as const)
      : closeOrderType === 'LIMIT'
        ? ({ type: 'LIMIT', limitPrice: closePrice } as const)
        : ({ type: 'STOP_MARKET', stopPrice: closePrice } as const);

  const submitOpen = () => {
    if (invalidOpen || disabled || pending) return;
    if (confirmationsEnabled && !confirming) {
      setConfirming(true);
      return;
    }
    onSubmit({
      entryId: account.id,
      symbol,
      intent: 'OPEN',
      positionSide,
      sizing: { type: sizingMode, amount: sizeAmount },
      leverage,
      execution: openExecution,
      ...(takeProfitPrice ? { takeProfitPrice } : {}),
      ...(stopLossPrice ? { stopLossPrice } : {}),
    });
    setConfirming(false);
  };

  const submitClose = () => {
    if (!position || invalidClose || disabled || pending) return;
    if (confirmationsEnabled && !confirming) {
      setConfirming(true);
      return;
    }
    onSubmit({
      entryId: account.id,
      symbol,
      intent: 'CLOSE',
      positionSide: position.side,
      amount: { type: 'PERCENTAGE', percentageBps: closePercentage },
      execution: closeExecution,
    });
    setConfirming(false);
  };

  return (
    <aside className="professional-order-ticket">
      <div className="ticket-primary-head">
        <div className="ticket-primary-tabs" role="tablist" aria-label="Trading actions">
          {(['ORDER', 'SELL'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={ticketTab === tab}
              className={ticketTab === tab ? 'is-active' : ''}
              onClick={() => {
                setTicketTab(tab);
                setConfirming(false);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        <button
          className="ticket-settings-trigger"
          onClick={() => setSettingsOpen((value) => !value)}
          aria-label="Order settings"
        >
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

      {ticketTab === 'ORDER' ? (
        <div className="ticket-tab-panel" role="tabpanel">
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
              SELL / SHORT <kbd>S</kbd>
            </button>
          </div>

          <OrderTypeTabs
            value={orderType}
            onChange={(value) => {
              setOrderType(value);
              setConfirming(false);
            }}
          />

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
              onClick={() => changeSizingMode('MARGIN')}
            >
              Margin
            </button>
            <button
              className={sizingMode === 'POSITION_SIZE' ? 'is-active' : ''}
              onClick={() => changeSizingMode('POSITION_SIZE')}
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
                aria-label={
                  sizingMode === 'MARGIN' ? 'Margin amount in USD' : 'Position size in USD'
                }
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

          <div className="order-preview-grid">
            <div className="position-size-preview">
              <span>POSITION SIZE</span>
              <strong className="tabular">{formatUsd(positionSize)}</strong>
              <div className="position-size-preview__meta">
                <small>
                  {leverage}x · {formatUsd(marginRequired)} margin
                </small>
                <small className="tabular">
                  Mark {market?.markPrice ? formatPrice(market.markPrice, symbol) : '—'} · Fee ~
                  {formatUsd(estimatedFee.toFixed(2))}
                </small>
              </div>
            </div>
            <dl className="order-estimate order-estimate--primary">
              <div>
                <dt>Margin required</dt>
                <dd className="tabular">{formatUsd(marginRequired)}</dd>
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
          </div>
          <Button
            className={cn('professional-submit', positionSide === 'SHORT' && 'is-short')}
            disabled={disabled || invalidOpen || pending}
            onClick={submitOpen}
          >
            {pending
              ? 'Submitting…'
              : confirming
                ? `Confirm ${positionSide} ${symbol.split('-')[0]}`
                : `${orderType === 'MARKET' ? 'Place' : 'Create'} ${positionSide} Order`}
          </Button>
        </div>
      ) : (
        <div className="ticket-tab-panel sell-ticket" role="tabpanel">
          {position ? (
            <>
              <div className="sell-position-summary">
                <AssetIcon symbol={position.symbol} size={30} />
                <div>
                  <strong>{position.symbol.replace('-', '/')}</strong>
                  <span>
                    {position.side} · {position.leverage}x
                  </span>
                </div>
                <b
                  className={cn(
                    'tabular',
                    position.unrealizedPnL.startsWith('-')
                      ? 'negative'
                      : isPositive(position.unrealizedPnL) && 'positive',
                  )}
                >
                  {formatUsd(position.unrealizedPnL, { signed: true })}
                  <small>{formatPercent(position.percentageReturn)} ROI</small>
                </b>
              </div>
              <div className="close-semantics">
                <span>{position.side === 'LONG' ? 'SELL TO CLOSE' : 'BUY TO CLOSE'}</span>
                <p>
                  {position.side === 'LONG'
                    ? 'Reducing this long sends the server a close intent.'
                    : 'Reducing this short buys back exposure. It never opens or reverses a long.'}
                </p>
              </div>
              <OrderTypeTabs
                value={closeOrderType}
                onChange={(value) => {
                  setCloseOrderType(value);
                  setConfirming(false);
                }}
              />
              <div className="close-size-control">
                <span>POSITION REDUCTION</span>
                <div role="group" aria-label="Position reduction">
                  {percentages.map((percentage) => (
                    <button
                      key={percentage}
                      className={closePercentage === percentage ? 'is-active' : ''}
                      onClick={() => {
                        setClosePercentage(percentage);
                        setConfirming(false);
                      }}
                    >
                      {percentage / 100}%
                    </button>
                  ))}
                </div>
              </div>
              {closeOrderType !== 'MARKET' ? (
                <label className="terminal-field">
                  <span>{closeOrderType === 'LIMIT' ? 'LIMIT PRICE' : 'STOP TRIGGER'}</span>
                  <div>
                    <i>$</i>
                    <input
                      value={closePrice}
                      onChange={(event) => setClosePrice(event.target.value)}
                      placeholder={market?.price ?? '0.00'}
                      inputMode="decimal"
                      aria-label={
                        closeOrderType === 'LIMIT' ? 'Close limit price' : 'Close stop trigger'
                      }
                    />
                    <b>USD</b>
                  </div>
                </label>
              ) : null}
              <dl className="close-position-detail">
                <div>
                  <dt>Open size</dt>
                  <dd className="tabular">
                    {formatQuantity(position.quantity, position.symbol)}{' '}
                    {MARKET_REGISTRY[position.symbol].baseAsset}
                  </dd>
                </div>
                <div>
                  <dt>Position notional</dt>
                  <dd className="tabular">{formatUsd(position.notional)}</dd>
                </div>
                <div>
                  <dt>Margin released proportionally</dt>
                  <dd className="tabular">{closePercentage / 100}%</dd>
                </div>
                <div>
                  <dt>Reference mark</dt>
                  <dd className="tabular">
                    {market?.markPrice ? formatPrice(market.markPrice, symbol) : '—'}
                  </dd>
                </div>
              </dl>
              <Button
                className={cn(
                  'professional-submit close-position-submit',
                  position.side === 'LONG' && 'is-short',
                )}
                disabled={disabled || invalidClose || pending}
                onClick={submitClose}
              >
                {pending
                  ? 'Submitting…'
                  : confirming
                    ? `Confirm ${closePercentage / 100}% Close`
                    : position.side === 'SHORT'
                      ? `Buy to Close ${closePercentage / 100}% SHORT`
                      : `Close ${closePercentage / 100}% LONG Position`}
              </Button>
            </>
          ) : (
            <div className="sell-empty-state">
              <span>NO {symbol.replace('-', '/')} POSITION</span>
              <strong>Nothing to reduce</strong>
              <p>
                The SELL workspace is tied to the selected market and only submits close intents.
              </p>
              <button onClick={() => setTicketTab('ORDER')}>Return to Order</button>
            </div>
          )}
        </div>
      )}

      <p className="paper-disclaimer">SIMULATED ORDER · NO REAL FUNDS</p>
      {hotkeysEnabled && ticketTab === 'ORDER' ? (
        <span className="hotkey-hint">
          <Keyboard aria-hidden="true" /> Hotkeys enabled
        </span>
      ) : null}
    </aside>
  );
}
