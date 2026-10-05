# Marketplace: keyed dispatch and trips

DispatchJob maintains state keyed by job across location updates, competing acceptances, offer expiry, cancellation and rerouting. This is a reactive stateful process, not a fixed linear workflow. MatchProviders filters available nearby providers and returns candidates; IssueOffer owns expiring offers; MaintainTrip alone owns trip state. Only one provider may accept an assignment at a time.

A price quote has business meaning independent of its pricing algorithm. Customers and providers see only information needed for their side of an active job. Latitude, longitude and proximity selection remain semantic; H3, PostGIS, cache refresh and fanout concurrency are realization details. Keyed routing and exclusive assignment are obligations that a state type alone cannot prove.
