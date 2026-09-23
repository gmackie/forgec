# Thermal plant digital twin

An engineer investigates a lumped thermal plant. A scenario supplies heater power and ambient temperature over 100 seconds; calibration supplies thermal capacitance, conductance and initial temperature. RunPlantSimulation accepts a SimulationRequest identifying model, assembly, calibration, scenario, solver, step and stop time. SimulationMaster is external. RecordSimulation admits a matching report and is the only owner of SimulationRun and SimulationRunRecorded.

The representative Modelica model states C * der(temperature) = heatFlow - G * (temperature - ambientTemperature), with temperatures in kelvin, power in watts and positive physical parameter assumptions. It is a conservation equation, not a periodic application update. The model's continuous state and internal numerical steps do not become ConceptIR entities or facts. The SSD sketch exposes two inputs and one output and references an intentionally absent ThermalPlant.fmu.

A run can fail because the FMU is missing, units mismatch, parameters are invalid, initialization fails, the integrator cannot meet tolerance, or the external worker exits. Such failures must produce diagnostic evidence rather than a fabricated trajectory. Measured sensor observations and simulated trajectories need distinct provenance and must never silently overwrite each other. The minimal graph records simulation evidence only; it does not ingest live telemetry or calibrate automatically.

No OpenModelica executable was available. The XML and connector names are statically inspected; no FMU was built, no SSP archive was executed and no trajectory exists. The example demonstrates an artifact interface and a place to admit future simulation results. It does not claim thermal fidelity or numerical validation.
