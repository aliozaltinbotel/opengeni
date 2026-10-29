import { useContext, useMemo, type ReactNode } from "react";
import {
  DEFAULT_PRODUCT_NAME,
  MessagesContext,
  layeredText,
  type MessagesContextValue,
  type OpenGeniMessages,
  type OpenGeniText,
  type UntypedText,
} from "./core";
export { DEFAULT_PRODUCT_NAME } from "./core";
export type {
  MessageParamValue,
  OpenGeniMessageCatalog,
  OpenGeniMessageKey,
  OpenGeniMessageParams,
  OpenGeniMessages,
  OpenGeniText,
  PluralCategory,
} from "./core";
import { englishMessages } from "./en";
import { singleSendText } from "./single-send";

/**
 * Every user-visible string the components render comes from one catalog, so a host can
 * show its own words and languages instead of the built-in English.
 *
 * - Keys are stable, dot-separated identifiers (`composer.send`). `englishMessages` is the
 *   complete default catalog; export it to your translation tooling as is.
 * - Templates use single-brace interpolation: `"Move queued prompt {index} up"`.
 * - `{product}` is the product name the person knows (`productName`, "Opengeni" by default), so
 *   an embedding product shows its own name without supplying every string that names it.
 * - Counted text uses plural-category suffixes (`_zero`, `_one`, `_two`, `_few`, `_many`,
 *   `_other`) selected with `Intl.PluralRules` for the active locale, so a language can supply
 *   exactly the forms it needs. `_other` is required for every counted key. Where the
 *   runtime has no `Intl.PluralRules` (Hermes on React Native), 1 selects `_one` and every
 *   other count `_other`.
 * - A key a host does not supply falls back to an outer provider, then English, never to a
 *   raw key.
 */
/** The plain translation function, for code outside React and for tests. */
export function createOpenGeniText(
  options: {
    messages?: OpenGeniMessages | undefined;
    locale?: string | undefined;
    /** The name `{product}` shows. Default "Opengeni". */
    productName?: string | undefined;
  } = {},
): OpenGeniText {
  return layeredText(
    englishMessages,
    options.messages ?? {},
    options.locale,
    null,
    options.productName ?? DEFAULT_PRODUCT_NAME,
  );
}

const ENGLISH: MessagesContextValue = {
  text: createOpenGeniText(),
  locale: undefined,
  productName: DEFAULT_PRODUCT_NAME,
};

export type OpenGeniMessagesProviderProps = {
  /** BCP 47 locale for plural rules and for the dates, times and numbers components format. */
  locale?: string | undefined;
  /** Your text for any subset of keys. Missing keys come from an outer provider, then English. */
  messages?: OpenGeniMessages | undefined;
  /**
   * The product name people know, shown wherever the built-in text names the product
   * (`{product}`). Default "Opengeni", or the name an outer provider set.
   */
  productName?: string | undefined;
  children?: ReactNode;
};

/**
 * Supplies text and locale to every Opengeni component below it. `OpenGeniProvider`
 * accepts the same `locale` and `messages`; use this one for components rendered outside it.
 */
export function OpenGeniMessagesProvider({
  locale,
  messages,
  productName,
  children,
}: OpenGeniMessagesProviderProps) {
  const outer = useContext(MessagesContext) ?? ENGLISH;
  const value = useMemo<MessagesContextValue>(() => {
    if (!messages && locale === undefined && productName === undefined) return outer;
    const resolvedLocale = locale ?? outer.locale;
    const resolvedProduct = productName ?? outer.productName;
    const fallback = outer === ENGLISH ? null : (outer.text as unknown as UntypedText);
    return {
      text: layeredText(englishMessages, messages ?? {}, resolvedLocale, fallback, resolvedProduct),
      locale: resolvedLocale,
      productName: resolvedProduct,
    };
  }, [locale, messages, productName, outer]);
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/** The translation function of the nearest messages provider (English without one). */
export function useOpenGeniText(): OpenGeniText {
  return (useContext(MessagesContext) ?? ENGLISH).text;
}

/**
 * Words for one Send: while `enabled`, every Opengeni component below reads
 * the single-Send wording (`singleSendText`) instead of Queue and Steer
 * phrases. The stock conversation screens apply it themselves under
 * `busySend: "steer"`; use it around your own composition of the parts.
 */
export function SingleSendWording({
  enabled = true,
  children,
}: {
  enabled?: boolean | undefined;
  children?: ReactNode;
}) {
  const outer = useContext(MessagesContext) ?? ENGLISH;
  const value = useMemo<MessagesContextValue>(
    () => (enabled ? { ...outer, text: singleSendText(outer.text) } : outer),
    [enabled, outer],
  );
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/** The host locale for formatting, or `undefined` for the runtime default. */
export function useOpenGeniLocale(): string | undefined {
  return useContext(MessagesContext)?.locale;
}
