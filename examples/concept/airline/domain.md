# Airline: disruption recovery

Disruption recovery combines flights, aircraft availability, crew duty, gates, weather and airspace restrictions. FleetFeasibility, CrewFeasibility and AirspaceFeasibility produce typed intermediate results for BuildRecoveryPlan. These are process returns, not new primitive kinds. BuildRecoveryPlan owns proposals; ApplyRecovery waits for human approval and alone maintains Flight.

A proposal has an effective time and must preserve crew duty and aircraft safety constraints. A cheaper schedule is not acceptable if it violates them. Weather and ATC events, changed crew state and periodic replanning can activate the same process. Optimizer search strategy is replaceable; feasible constraints, objective meaning and approval authority are business semantics.
