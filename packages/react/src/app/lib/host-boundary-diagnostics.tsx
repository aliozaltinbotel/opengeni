import type { RootOptions } from "react-dom/client";

/** Explicit opt-in for boundaries that emit their own content-free host diagnostic. */
export const HOST_BOUNDARY_DIAGNOSTICS = Symbol("host-boundary-diagnostics");

/** Retain native errors and component stacks, except for opted-in host boundaries. */
export const reportCaughtError: NonNullable<RootOptions["onCaughtError"]> = (error, { errorBoundary, componentStack }) => {
  if (errorBoundary && HOST_BOUNDARY_DIAGNOSTICS in errorBoundary && errorBoundary[HOST_BOUNDARY_DIAGNOSTICS] === true) return;
  console.error(error, componentStack);
};
