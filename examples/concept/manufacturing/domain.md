# Manufacturing: telemetry, quality and maintenance

ReceiveTelemetry accepts high-rate observations from plant control and historical backfill. CalculateTemperatureWindow derives a named 90-minute business summary; DetectExcursion combines that summary with batch genealogy before putting product on hold. Releasing a hold requires a quality decision. MaintainMachine owns current machine condition across fault and maintenance events.

A maintenance order waits for technician completion while observation ingestion continues. PlantControl and Historian are semantic systems; OPC UA, PLC protocols, partitions and stream operator choices are L1. Event-time versus arrival-time windows, late observations and quality thresholds materially change business outcomes and must not be hidden behind a provider binding.
