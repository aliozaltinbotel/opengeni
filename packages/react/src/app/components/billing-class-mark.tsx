/** Web compatibility export; the canonical rail mark lives in the React SDK. */
import {
  BillingClassMark as SharedBillingClassMark,
  type ModelPolicyPickerGroupPresentation,
} from "../../components/model-policy-picker";
import type { ComponentPropsWithoutRef } from "react";
import { OpengeniMark } from "./brand-mark";

/** First-party branding is explicit; embedded package defaults stay neutral. */
export const openGeniGroupPresentation: ModelPolicyPickerGroupPresentation = {
  opengeni_credits: { label: "Opengeni", icon: <OpengeniMark /> },
};

export function BillingClassMark(props: ComponentPropsWithoutRef<typeof SharedBillingClassMark>) {
  return (
    <SharedBillingClassMark
      {...props}
      presentation={
        props.billingClass === "opengeni_credits"
          ? {
              ...openGeniGroupPresentation.opengeni_credits,
              ...props.presentation,
              label: props.presentation?.label ?? openGeniGroupPresentation.opengeni_credits?.label,
              icon:
                props.presentation?.icon === undefined
                  ? openGeniGroupPresentation.opengeni_credits?.icon
                  : props.presentation.icon,
            }
          : props.presentation
      }
    />
  );
}
export type { PickerBillingClass as BillingClass } from "../../model-policy";
