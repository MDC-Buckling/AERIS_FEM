# Spec: Weighted-Residual C¹-Kopplung (Phase 4) — Ludwig 6.3

Formelgenaue Vorlage für den C¹-Map. Quelle: Ludwig (2018) Kap. 6.3, verifiziert gegen
PDF-Seiten 80–85. Setzt Phase-1/2/3 voraus (Basis-Ableitungen, Quadratur, B-Matrizen, K_e —
einzeln gepinnt) UND die globale DOF-Map (Phase-3-Plumbing — C lebt in diesem Raum).

**Scope:** C¹ für *glatte* Bereiche (keine Knicke). G¹ an Knicken/Junctions (Kegel-Zylinder,
Ludwig Kap. 7) = separates späteres Spec. SS-Platte ist flach+glatt → C¹ via 6.3 reicht.

---

## 0. Architektur-Eingriff
Constraint-Elimination = linearer Map C, Kongruenz-Transform auf das im Phase-3-Loop
assemblierte K_full (roher Per-Element-BB-DOF-Raum):
```
K_indep = Cᵀ K_full C ,  f_indep = Cᵀ f_full ,  löse K_indep u_indep = f_indep ,  u_full = C u_indep
```
C drückt abhängige DOFs (geslavte Kontrollpunktreihe) als Linearkombination der unabhängigen aus.
Assembler/Material/Solver unangetastet — der ganze C¹-Code ist „baue C, transformiere K_full/f_full".
Exakt der Mechanismus von gsMappedBasis (Quads), hier selbst für Dreiecke gebaut.
**Conforming (Ritz / Π_s) verwenden, nicht non-conforming** (sonst Rang-Defizienz + weiche Moden).

## 1. Per-Seite Orthonormalbasis (Eq 6.9–6.14), Initialkonfiguration
Seiten-Tangente A_S = (w₁A₁+w₂A₂)/‖·‖, Gewichte:
```
Dreieck: Seite1 (0,−1); Seite2 (1,0); Seite3 (−1,1)
Quad:    Seite1 (1,0);  Seite2 (0,1); Seite3 (−1,0); Seite4 (0,−1)
```
Seiten-Normale A_N = A₃×A_S = v₁A₁+v₂A₂ (v₃=0). v₁,v₂ aus 3×3-System (Eq 6.14):
[A₁;A₂;A₃]ᵀ[v₁;v₂;v₃]=A_N, a_αβ=a_α·a_β. **v₁,v₂ gehen in den Constraint** (nicht w). Pro Seite + Element (±).

## 2. Constraint-Gleichungen (Eq 6.15–6.18). Master „+", Slave „−".
C¹ (Eq 6.15): v₁⁻a₁⁻+v₂⁻a₂⁻+v₁⁺a₁⁺+v₂⁺a₂⁺ = 0 entlang L.
Gewichtetes Residuum conforming (Eq 6.16): Π_s = ∫_L ½‖…‖² dL. Π_s **quadratisch** → Constraint
**linear** (nur Initialkonfig → einmal vorab).
Skalare Kontinuitätsfunktion pro CP k: g_k = v₁⁺N_k,1⁺+v₂⁺N_k,2⁺+v₁⁻N_k,1⁻+v₂⁻N_k,2⁻ (entlang L).
Constraint-Hessian (Eq 6.18): H_kl = ∫_L g_k g_l dL (Gauss-Legendre, max(p⁺,p⁻)+1 Pkt).
Lineare Constraints (Eq 6.17), pro k∈ℚ, Komponente i: Σ_{l∈ℙ∪ℚ} H_kl u_li = 0.
**Mengen (Fig 6.14):** ℚ = constrained = seitenbenachbarte Reihe des Slave; |ℚ|=p (Dreieck)/p+1 (Quad)
→ 3|ℚ| Gleichungen. ℙ = Seiten-CPs + benachbarte Reihe des Masters. System löst u_ℚ = LK(u_ℙ) → C.

## 3. C via Incomplete Gauss Elimination (6.3.5)
**Über-Constraint an inneren Vertices** (mehrere Seiten treffen) → Rang < Gleichungszahl →
Lagrange/Static-Condensation macht K singulär. Incomplete Gauss entfernt redundante Constraints.
**Zwei Schritte:** (1) pro innere Seite (für gerade Dreiecksseiten = punktweise Constraints, s. §4);
(2) global: alle Seiten + Einzelpunkt-BCs + MPCs zusammen → entfernt abhängige Gleichungen.
Mechanik: sparse A(n×m)+b, ≤n Schritte, volle Pivotsuche; kein Pivot→Restzeilen null; sonst
Pivotzeile/Pivot, aus anderen subtrahieren. Rang r → erste r×r = Identität. Pivot: Schritt 1
größter-Wert; Schritt 2 modified-Markowitz (Fill-in). sparse-tauglich.

## 4. ★ Querprobe gerade Dreiecksseiten (Zwei-Methoden-Disziplin) ★
Ludwig S.85: für gerade Seiten fallen Weighted-Residual-Constraints mit punktweisen (6.1.1,
Farins affine Sub-Dreieck-Bedingung) zusammen; incomplete Gauss REKONSTRUIERT die punktweisen.
→ Baue C über Weighted-Residual (§1–3) UND über punktweise (6.1.1: die zwei Zweite-Reihe-Slave-CPs
als LK der Master-Nachbarn + Seitenpunkte) → beide C MÜSSEN für gerade Seiten identisch sein.
Punktweise = einfacherer erster Pfad für die flache Platte; Weighted-Residual = allgemein (gekrümmt,
Quads, non-conforming).

## 5. Validierungs-Gates
1. **Über-Constraint:** 2 Dreiecke, gemeinsamer innerer Vertex → incomplete Gauss → korrekter
   reduzierter Rang, K_indep NICHT singulär.
2. **C¹-Patch-Test:** 2 Dreiecke, konstantes Krümmungsfeld → exakt reproduziert, keine künstliche
   Versteifung an der Naht (C⁰-Map würde versteifen = Scharnier-Gegenstück).
3. **Querprobe §4:** Weighted-Residual-C vs punktweise-C, gerade Seiten → identisch.
4. **★ Mehr-Dreieck-SS-Platte (Ludwig 8.1.3), h-Verfeinerung → Konvergenz ★ = PHASE-4-GATE.**
   Beweist C¹ wie Scordelis-Lo-Multipatch die Quad-C¹. Ohne korrektes C scharniert das Netz.

## 6. Nicht hier
G¹ an Knicken/Junctions (Kap. 7, Pure-Penalty/Mortar/Nitsche) = separates Spec. Pre-Processor
flaggt pro Seite C¹ vs G¹; SS-Platte überall C¹. Zweite Variation: Constraint linear+konfig-fix →
überlebt GNIA/Riks unverändert; non-conforming triggert Post-Buckling-Moden → conforming Default.

## Bau-Reihenfolge
Voraussetzung: Phase-3-Plumbing grün (DOF-Map). Dann: per-Seite v₁,v₂ (§1) → g_k+H_kl (§2) →
C via Gauss-Elim (§3) → Querprobe §4 → Über-Constraint+C¹-Patch (Gates 1,2) → K_indep=CᵀK_full C,
Solve → Mehr-Dreieck-SS-Platte (Gate 4).
