-------------------------- MODULE BoundedQuorum --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Nodes, Values, None
VARIABLES votes, decided
vars == <<votes, decided>>
Quorums == {q \in SUBSET Nodes : Cardinality(q) * 2 > Cardinality(Nodes)}
Init == /\ votes = [n \in Nodes |-> None]
        /\ decided = {}
Vote(n, v) == /\ votes[n] = None
              /\ votes' = [votes EXCEPT ![n] = v]
              /\ UNCHANGED decided
Decide(v) == /\ \E q \in Quorums : \A n \in q : votes[n] = v
             /\ decided' = decided \cup {v}
             /\ UNCHANGED votes
Next == (\E n \in Nodes, v \in Values : Vote(n, v))
        \/ (\E v \in Values : Decide(v))
TypeOK == /\ votes \in [Nodes -> Values \cup {None}]
          /\ decided \subseteq Values
Agreement == Cardinality(decided) <= 1
Validity == \A v \in decided : \E n \in Nodes : votes[n] = v
Spec == Init /\ [][Next]_vars
=============================================================================
