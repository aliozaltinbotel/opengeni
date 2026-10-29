import { DEFAULT_PRODUCT_NAME, layeredText } from "../../messages/core";
import { startupEnglishMessages } from "../../messages/startup-en";

/** Only the root app state's refusal copy and workspace-scope label. */
export const t = layeredText(startupEnglishMessages, {}, undefined, null, DEFAULT_PRODUCT_NAME);
