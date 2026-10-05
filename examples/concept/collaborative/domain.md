# Collaborative workspace: documents and offline edits

Many users edit a document concurrently, including offline edits. They supply commands and DocumentEdited occurrences to MaintainDocument, the single logical owner of Document. PublishVersion preserves content digests and ancestry; RestoreVersion is another command to that same owner. ManageComment and ManageShare own their separate entities, so comments and sharing do not become alternate document producers.

Workspace membership and document shares determine access, including inherited sharing and revocation. Presence is transient realization data. CRDT and OT are alternative merge strategies only while they preserve the agreed business conflict behavior. If user-visible conflict resolution changes, it must become a semantic requirement rather than silently remain L1.
