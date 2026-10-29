import { createContext } from "react";
import type { englishMessages } from "./en";

type Catalog = typeof englishMessages;
type CatalogKey = keyof Catalog & string;

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
type PluralSuffix = `_${PluralCategory}`;

type PluralBase<K> = K extends `${infer Base}_other` ? Base : never;
type PluralBaseKey = PluralBase<CatalogKey>;
type SingularKey<K> = K extends `${string}${PluralSuffix}` ? never : K;

/** A key a component asks for: plain keys, and counted keys without their plural suffix. */
export type OpenGeniMessageKey = SingularKey<CatalogKey> | PluralBaseKey;

type TemplateParams<S> = S extends `${string}{${infer Param}}${infer Rest}`
  ? Param | TemplateParams<Rest>
  : never;
type TemplateOf<K> = K extends CatalogKey
  ? Catalog[K]
  : K extends PluralBaseKey
    ? Catalog[`${K}_other` & CatalogKey]
    : never;
/** Filled from the provider's `productName`; callers never pass it. */
type ProductParam = "product";
type ParamNames<K> =
  | Exclude<TemplateParams<TemplateOf<K>>, ProductParam>
  | (K extends PluralBaseKey ? "count" : never);

/** The product name `{product}` shows when no provider sets one. */
export const DEFAULT_PRODUCT_NAME = "Opengeni";

/** Values interpolated into templates; `null` and `undefined` render as empty text. */
export type MessageParamValue = string | number | null | undefined;
export type OpenGeniMessageParams<K extends OpenGeniMessageKey> = {
  [P in ParamNames<K>]: P extends "count" ? number : MessageParamValue;
};

/**
 * Translate one key. Parameters are required exactly when the English template has them.
 * `locale` is the host locale to format dates, times and numbers with (`undefined` is the
 * runtime default).
 */
export type OpenGeniText = (<K extends OpenGeniMessageKey>(
  key: K,
  ...params: [ParamNames<K>] extends [never] ? [] : [OpenGeniMessageParams<K>]
) => string) & { readonly locale: string | undefined };

/**
 * Host-supplied text. Any subset of keys; counted keys may add the plural forms their
 * language uses (`files.count_few`) even where English has none.
 */
export type OpenGeniMessages = Partial<
  Record<SingularKey<CatalogKey> | `${PluralBaseKey}${PluralSuffix}`, string>
>;

/** A complete catalog: declare yours with this type to be told about every new key. */
export type OpenGeniMessageCatalog = Record<SingularKey<CatalogKey>, string> &
  Record<`${PluralBaseKey}_other`, string> &
  Partial<Record<`${PluralBaseKey}${PluralSuffix}`, string>>;

export type Lookup = Readonly<Record<string, string | undefined>>;
export type UntypedText = (key: string, params?: Record<string, MessageParamValue>) => string;

type PluralSelector = { select(count: number): string };
/** One/other, for runtimes without `Intl.PluralRules`. */
const ONE_OTHER: PluralSelector = { select: (count) => (count === 1 ? "one" : "other") };
const pluralRuleCache = new Map<string, PluralSelector>();
function pluralRules(locale: string | undefined): PluralSelector {
  const cacheKey = locale ?? "";
  let rules = pluralRuleCache.get(cacheKey);
  if (!rules) {
    rules = createPluralRules(locale) ?? createPluralRules("en") ?? ONE_OTHER;
    pluralRuleCache.set(cacheKey, rules);
  }
  return rules;
}

function createPluralRules(locale: string | undefined): PluralSelector | null {
  if (typeof Intl === "undefined" || typeof Intl.PluralRules !== "function") return null;
  try {
    return new Intl.PluralRules(locale);
  } catch {
    return null;
  }
}

function interpolate(template: string, params: Record<string, MessageParamValue> | undefined) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? "") : match,
  );
}

function pick(
  catalog: Lookup,
  key: string,
  locale: string | undefined,
  count: number | undefined,
): string | undefined {
  if (count === undefined) return catalog[key];
  const category = pluralRules(locale).select(count);
  return catalog[`${key}_${category}`] ?? catalog[`${key}_other`] ?? catalog[key];
}

function countOf(params: Record<string, MessageParamValue> | undefined): number | undefined {
  return typeof params?.count === "number" ? params.count : undefined;
}

export function layeredText(
  defaults: Lookup,
  host: Lookup,
  locale: string | undefined,
  fallback: UntypedText | null,
  productName: string,
): OpenGeniText {
  const text: UntypedText = (key, given) => {
    // An outer provider's text receives this name too, so the nearest name wins.
    const params = { product: productName, ...given };
    const count = countOf(params);
    const own = pick(host, key, locale, count);
    if (own !== undefined) return interpolate(own, params);
    if (fallback) return fallback(key, params);
    return interpolate(pick(defaults, key, "en", count) ?? key, params);
  };
  return Object.assign(text, { locale }) as unknown as OpenGeniText;
}

export type MessagesContextValue = {
  text: OpenGeniText;
  locale: string | undefined;
  productName: string;
};

// One context for the public full fallback and the startup-only readers.
export const MessagesContext = createContext<MessagesContextValue | null>(null);
