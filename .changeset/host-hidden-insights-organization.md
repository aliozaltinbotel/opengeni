---
"@opengeni/react": minor
---

A host extension that hides the `insights` destination now also hides Organization > Insights: the settings rail and settings search leave it out, and `organization?section=insights` renders the not-found page. New export `isOrganizationSectionHidden` in `@opengeni/react/app/host-extension`. Without a host extension, or one that does not hide `insights`, nothing changes.
