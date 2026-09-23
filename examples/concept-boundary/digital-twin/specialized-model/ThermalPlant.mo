within ;
model ThermalPlant "Lumped thermal plant; SI units, no controller"
  parameter Real C(unit="J/K") = 1000 "Thermal capacitance";
  parameter Real G(unit="W/K") = 10 "Conductance to environment";
  parameter Real T0(unit="K") = 293.15;
  input Real heatFlow(unit="W");
  input Real ambientTemperature(unit="K");
  output Real temperature(unit="K", start=T0, fixed=true);
equation
  C * der(temperature) = heatFlow - G * (temperature - ambientTemperature);
  annotation(experiment(StartTime=0, StopTime=100, Tolerance=1e-6));
end ThermalPlant;
