# Security Dependency Triage

Date: 2026-07-07
Risk owner: LAUNCH_OWNER (replace with named accountable owner before production approval)

## Backend unresolved audit findings
- advisory: GHSA-3gc7-fjrx-p6mg
  package: bigint-buffer
  dependency path: @switchboard-xyz/on-demand -> @solana/spl-token/@solana/web3.js -> bigint-buffer
  component: backend
  direct/transitive: transitive
  runtime reachable?: yes, Solana/Switchboard transaction building paths may load the package
  browser reachable?: no
  fixed version?: npm audit only offers force downgrade/breaking Solana stack changes
  reason not fixed: `npm audit fix --force` would install incompatible Solana packages and risk breaking settlement/reveal
  mitigation: only backend operators can submit crank transactions; validate inputs; pin lockfile; revisit Solana/Switchboard compatible upgrade immediately
  accepted until: 2026-07-21
  launch blocker: no for limited MVP if owner signs acceptance
- advisory: GHSA-w5hq-g745-h8pq
  package: uuid
  dependency path: @solana/web3.js -> jayson -> uuid
  component: backend
  direct/transitive: transitive
  runtime reachable?: yes through RPC stack
  browser reachable?: no
  fixed version?: force downgrade to incompatible @solana/web3.js per npm audit
  reason not fixed: breaking Solana compatibility
  mitigation: do not expose arbitrary UUID buffer APIs; upgrade when Solana web3 publishes compatible fix
  accepted until: 2026-07-21
  launch blocker: no for limited MVP if owner signs acceptance

## Frontend unresolved audit findings
- advisory: GHSA-xq3m-2v4x-88gg and related protobufjs critical advisories
  package: protobufjs
  dependency path: wallet adapter/Trezor/Switchboard transitive paths
  component: frontend
  direct/transitive: transitive
  runtime reachable?: potentially if affected wallet adapters are bundled/used
  browser reachable?: yes
  fixed version?: partial non-force fix attempted; remaining fix requires dependency selection/force changes
  reason not fixed: broad wallet-adapter dependency tree; force path is breaking and needs product wallet support decision
  mitigation: disable/remove affected wallet adapters before production, ship only audited wallet adapters, or obtain explicit owner acceptance
  accepted until: 2026-07-21
  launch blocker: yes until affected browser-reachable adapters are removed or risk is explicitly signed by owner
- advisory: GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh, GHSA-xxjr-mmjv-4gpg
  package: lodash
  dependency path: WalletConnect/Reown transitive
  component: frontend
  direct/transitive: transitive
  runtime reachable?: potentially through WalletConnect flows
  browser reachable?: yes
  fixed version?: force changes required
  reason not fixed: breaking wallet adapter changes
  mitigation: disable WalletConnect/Reown adapters or upgrade wallet stack in a dedicated compatibility pass
  accepted until: 2026-07-21
  launch blocker: yes unless disabled or owner accepts
- advisory: GHSA-848j-6mx2-7j84
  package: elliptic
  dependency path: Torus/WalletConnect/Trezor transitive
  component: frontend
  direct/transitive: transitive
  runtime reachable?: potentially through affected wallet adapters
  browser reachable?: yes
  fixed version?: force changes required
  reason not fixed: breaking wallet adapter changes
  mitigation: disable affected adapters for MVP; use only Phantom/Solflare if clean after re-audit
  accepted until: 2026-07-21
  launch blocker: yes unless disabled or owner accepts
- advisory: GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p
  package: ws
  dependency path: WalletConnect/Reown transitive
  component: frontend
  direct/transitive: transitive
  runtime reachable?: dev/build dependency and walletconnect path
  browser reachable?: limited, but dependency is in browser bundle tree
  fixed version?: force changes required
  reason not fixed: breaking wallet adapter changes
  mitigation: disable WalletConnect/Reown for MVP
  accepted until: 2026-07-21
  launch blocker: yes unless disabled or owner accepts
- advisory: GHSA-3gc7-fjrx-p6mg and GHSA-w5hq-g745-h8pq
  package: bigint-buffer / uuid
  dependency path: @solana/web3.js / @solana/spl-token transitive
  component: frontend
  direct/transitive: transitive
  runtime reachable?: yes for Solana tx building
  browser reachable?: yes
  fixed version?: force downgrade/breaking path
  reason not fixed: Solana ecosystem compatibility
  mitigation: pin versions, monitor upstream, minimize user-controlled binary parsing
  accepted until: 2026-07-21
  launch blocker: no for MVP only with owner acceptance
