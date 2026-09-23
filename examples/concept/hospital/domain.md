# Hospital: care and emergency access

MaintainEncounter coordinates a stay lasting days or weeks while prescribing, labs and transfers progress independently. ReceiveLab preserves the external source digest and observation time. PrescribeMedication requires a clinician decision before sending a medication order to the pharmacy. TransferPatient changes the care location without creating a second Encounter owner.

Routine access requires treatment purpose, the same hospital and membership of the care team. Emergency access is a separate process and policy requiring an emergency role, a declared reason and an audited EmergencyAccessUsed occurrence. It must not be a universal bypass or a second clinical-record producer. The graph represents both policies, but cannot prove every emergency read emits an audit event or enforce medication dose safety.
