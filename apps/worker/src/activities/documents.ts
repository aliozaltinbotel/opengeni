import type { DocumentServices } from "@opengeni/documents";
import {
  resolveDocumentIndexAuthority,
  isTransactionHandle,
  rlsContextForWorkspace,
  withSessionRlsActorContext,
  withWorkspaceUsageLock,
} from "@opengeni/db";
import type { ControlActivityServices, IndexDocumentInput } from "./types";

export function createDocumentActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  return {
    indexDocument: async (input: IndexDocumentInput) => {
      const { db, objectStorage } = await services();
      if (isTransactionHandle(db)) throw new Error("DOCUMENT_PREPARATION_REQUIRES_ROOT_DATABASE");
      if (!objectStorage) {
        throw new Error("object storage is not configured");
      }
      if (!resolveDocumentServices) {
        throw new Error("document services are not configured");
      }
      const [{ getDocumentForIndexing, indexDocumentNow }, documentServices] = await Promise.all([
        import("@opengeni/documents"),
        resolveDocumentServices(),
      ]);
      const context = await rlsContextForWorkspace(db, input.workspaceId);
      if (context.accountId !== input.accountId) {
        throw new Error("document account/workspace authority mismatch");
      }
      const storedAuthority = await withWorkspaceUsageLock(db, input.workspaceId, async (lockedDb) => {
        const storedAuthority = await resolveDocumentIndexAuthority(lockedDb, input);
        if (!storedAuthority) {
          throw new Error("document authority was not found before indexing");
        }
        const suppliedAuthorityFields = [
          "authorityKind",
          "authorityWorkspaceId",
          "authoritySubjectId",
        ] as const;
        const suppliedCount = suppliedAuthorityFields.filter((field) =>
          Object.prototype.hasOwnProperty.call(input, field),
        ).length;
        const suppliedMismatch =
          (Object.prototype.hasOwnProperty.call(input, "authorityKind") &&
            input.authorityKind !== storedAuthority.authorityKind) ||
          (Object.prototype.hasOwnProperty.call(input, "authorityWorkspaceId") &&
            input.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId) ||
          (Object.prototype.hasOwnProperty.call(input, "authoritySubjectId") &&
            input.authoritySubjectId !== storedAuthority.authoritySubjectId);
        if (suppliedMismatch) {
          throw new Error("document authority changed before indexing");
        }
        if (suppliedCount !== 0 && suppliedCount !== suppliedAuthorityFields.length) {
          throw new Error("document authority tuple is partial");
        }
        const claimedDocument = await getDocumentForIndexing(
          lockedDb,
          input.workspaceId,
          input.documentId,
          { viewerSubjectId: storedAuthority.authoritySubjectId },
        );
        if (
          !claimedDocument ||
          claimedDocument.authorityKind !== storedAuthority.authorityKind ||
          claimedDocument.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
          claimedDocument.authoritySubjectId !== storedAuthority.authoritySubjectId
        ) {
          throw new Error("document authority changed before indexing");
        }
        return storedAuthority;
      });
      // The installed preparation claim/complete gates own their transactions.
      // Object storage and parsing must not inherit this admission transaction.
      const document = await withSessionRlsActorContext(
        {
          subjectId: "service:document-preparation",
          privateFileOwnerSubjectId:
            storedAuthority.authorityKind === "personal"
              ? storedAuthority.authoritySubjectId
              : null,
        },
        () => indexDocumentNow(
          db,
          objectStorage,
          input.workspaceId,
          input.documentId,
          documentServices,
          { viewerSubjectId: storedAuthority.authoritySubjectId },
        ),
      );
      const currentAuthority = await resolveDocumentIndexAuthority(db, input);
      if (
        !currentAuthority ||
        currentAuthority.authorityKind !== storedAuthority.authorityKind ||
        currentAuthority.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
        currentAuthority.authoritySubjectId !== storedAuthority.authoritySubjectId ||
        document.authorityKind !== storedAuthority.authorityKind ||
        document.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
        document.authoritySubjectId !== storedAuthority.authoritySubjectId
      ) {
        throw new Error("document authority changed before indexing");
      }
      return document;
    },
  };
}
