# Pi Mode A compatibility spike

This repository validates Pi Mode A delegation without modifying Pi or OMP.
The probe is intentionally not registered in the package manifest; run it only
for compatibility verification:

```bash
pi -e ./src/pi-adapter/spike-extension.ts
```

Select a real model, then select `auto-router-spike/probe`. The probe delegates
to the real model selected immediately before the virtual model.

## Required public capability set

The integration uses only these documented Pi public methods:

- `ModelRegistry.find(provider, model)`
- `ModelRegistry.getProvider(provider)`
- `ModelRegistry.getApiKeyAndHeaders(model)`
- `Provider.streamSimple(model, context, options)`
- `createAssistantMessageEventStream()`

The Adapter checks the first three methods at runtime. Missing methods yield an
actionable `PiDelegationError`; it does not infer support from the Pi version.

## Delegation contract

- The target Provider receives its own resolved API key, headers, base URL and
  provider environment.
- The virtual Provider's API key, headers, environment and reasoning value are
  removed before target options are constructed.
- Cancellation and other behavioral stream options are forwarded.
- Text, thinking, image, tool-call and terminal events are forwarded unchanged.
- A virtual target is rejected to prevent recursive delegation.

## Compatibility boundary

Pi 0.84.1 is the initial research baseline, not an exact runtime requirement.
A host is compatible when it exposes the capability set above through the same
public contracts. This extension never patches, monkey-patches, vendors,
copies, or writes to Pi/OMP source or installation directories.
