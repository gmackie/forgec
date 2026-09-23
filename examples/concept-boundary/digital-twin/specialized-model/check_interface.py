"""Static source/SSD seam check only. Does not compile or simulate Modelica."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent
ns = {"ssd": "http://ssp-standard.org/SSP1/SystemStructureDescription",
      "ssc": "http://ssp-standard.org/SSP1/SystemStructureCommon"}
tree = ET.parse(root / "SystemStructure.ssd")
assert tree.getroot().attrib["version"] == "2.0"
system = tree.getroot().find("ssd:System", ns)
component = system.find("ssd:Elements/ssd:Component", ns)
expected = {"heatFlow": ("input", "W"),
            "ambientTemperature": ("input", "K"),
            "temperature": ("output", "K")}

def connectors(element):
    return {c.attrib["name"]: (c.attrib["kind"], c.find("ssc:Real", ns).attrib["unit"])
            for c in element.find("ssd:Connectors", ns)}

assert connectors(system) == connectors(component) == expected
source = (root / "ThermalPlant.mo").read_text()
for name, (direction, unit) in expected.items():
    assert re.search(rf'{direction}\s+Real\s+{name}\(unit="{unit}"', source)
connections = {tuple(sorted(c.attrib.items())) for c in system.find("ssd:Connections", ns)}
expected_connections = [dict(startConnector=name, endElement="thermal", endConnector=name)
                        for name in ["heatFlow", "ambientTemperature"]]
expected_connections.append(dict(startElement="thermal", startConnector="temperature", endConnector="temperature"))
assert connections == {tuple(sorted(c.items())) for c in expected_connections}
assert component.attrib["source"] == "resources/ThermalPlant.fmu"
print("PASS: XML, source names/directions/units and connection endpoints; no compilation or simulation")
