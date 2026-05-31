# Spec: BB-Element B-Matrizen (Membran + Biegung) — Ludwig 4.54–4.61

Formelgenaue Vorlage für den Phase-3-Element-Code. Quelle: Ludwig (2018), Kap. 4.2.
Verifiziert gegen die PDF-Seiten 45–47. Zwei Druckfehler korrigiert (s. §5).

Begleitend: δn ist am SS-Platten-Gate inert (§3.4), das Vorzeichen wird aus gismos
`_getBcov` gespiegelt, nicht aus Ludwig gewählt (§0).

---

## 0. Notation & Konvention-Anker

- DOF: `u_ki` = i-te kartesische Komponente (i∈{1,2,3}) der Verschiebung am Kontrollpunkt k.
- `N_k,α` = ∂N_k/∂ξ^α, `N_k,αβ` = ∂²N_k/∂ξ^α∂ξ^β (aus Phase 1, bewiesen).
- `A_α`, `A_α,β`, `A₃` = Referenz-Tangenten / -Ableitungen / -Normale.
- `a_α`, `a_α,β`, `a₃` = deformierte Gegenstücke. `ā₃ = a₁×a₂`, `a₃ = ā₃/‖ā₃‖`.
- `a_βi` = i-te kartesische Komponente von a_β.
- **Voigt-Reihenfolge: [11, 22, 12]**, **Faktor 2 auf der Schub-/Twist-Zeile**
  (Ingenieurkonvention, strain-energy-konsistent mit ABD). → gegen gismo `flat()`/`_getAcov`
  verifizieren (Uniaxial- + Reinschub-Patch).
- **Vorzeichen NICHT frei wählen:** b_αβ exakt wie `_getBcov`, κ in der ref−def-Reihenfolge
  von gismos `E_f`. Ludwig = Variationsstruktur; gismo = Vorzeichen + Metrik. Arbiter:
  Konstant-Krümmungs-Patch (M = D·κ, Vorzeichen des Moments prüfen).

---

## 1. Geometrische Größen pro Quadraturpunkt

Referenz (Eq 4.52):  A_α = Σ_k N_k,α X_k ,   A_α,β = Σ_k N_k,αβ X_k
Deformiert (Eq 4.53): a_α = A_α + Σ_k N_k,α u_k ,   a_α,β = A_α,β + Σ_k N_k,αβ u_k
Normale: ā₃ = a₁×a₂ ,  a₃ = ā₃/‖ā₃‖  (Referenz analog: Ā₃, A₃)
Flächen-Jacobi (Referenz): J = ‖Ā₃‖ = ‖A₁×A₂‖.

---

## 2. Membran-B-Matrix B_m (Eq 4.59, erste Zeile)

Tensorkomponente:  ∂E_αβ/∂u_ki = ½ (N_k,α · a_βi + N_k,β · a_αi)
(Typo korrigiert: Thesis a_βj/a_αj → a_βi/a_αi, §5.)

Voigt-Zeilen für DOF-Spalte (k,i):
```
Zeile 11   :  N_k,1 · a_1i
Zeile 22   :  N_k,2 · a_2i
Zeile 2·12 :  N_k,1 · a_2i + N_k,2 · a_1i      ← Faktor 2 absorbiert die ½
```
B_m: 3 Zeilen × 3·|K| Spalten (p=5-Dreieck: |K|=21 → 63 Spalten).

---

## 3. Biege-B-Matrix B_b (Eq 4.60 / 4.61)

### 3.1 Definition
b_αβ = − a_α,β · a₃   (Referenz: B_αβ = − A_α,β · A₃)
κ_αβ = b_αβ − B_αβ.  → b_αβ-Vorzeichen aus `_getBcov`, κ-Reihenfolge aus `E_f` (ref−def).

### 3.2 Erste Variation (Eq 4.61, erste Zeile)
∂κ_αβ/∂u_ki = − N_k,αβ · a_3i − a_α,β · ∂a₃/∂u_ki
Voigt-Zeilen wie B_m (11, 22, 2× Twist 12).

### 3.3 Normalenvariation ∂a₃/∂u_ki (Eq 4.55 / 4.56) — heikelste Stelle
∂a₃/∂u_ki = (1/‖ā₃‖) · [ I − a₃⊗a₃ ] · ∂ā₃/∂u_ki
∂ā₃/∂u_ki = N_k,1 · (e_i × a₂) + N_k,2 · (a₁ × e_i)

### 3.4 ★ STAGING: flach vs. gekrümmt ★
Der zweite Term in 3.2 ∝ a_α,β = A_α,β (Referenz).
- **SS-Platte (flach, affine Per-Element-Geometrie, Ludwig 5.3 Schritt 1):** A_α,β = 0
  → δn-Term verschwindet → **B_b = − N_k,αβ · a_3i.** 3.3-Maschinerie inert.
  Rigid-Rotation: −a₃·(θ × A_α,β) = 0.
- **Zylinder-LBA (Ludwig 5.3 zylindrisch):** A_α,β ≠ 0 → δn ERFORDERLICH; Rigid-Rotation
  auf gekrümmter Referenz ist das δn-Gate.

---

## 4. Element-Steifigkeit
K_e = Σ_qp w_qp · J_qp · ( B_mᵀ A B_m + B_mᵀ B B_b + B_bᵀ B B_m + B_bᵀ D B_b )
A,B,D (3×3, Voigt [11,22,12]) aus `gsMaterialMatrixLinear::eval3D_matrix(patch,u_qp,z,MatrixA|B|D)`
punktweise; Durchdicken-Integration steckt drin. w_qp Dreiecks-Quadratur (Phase 2),
J_qp = ‖Ā₃‖.

---

## 5. Druckfehler in der Thesis (port-relevant)

| Gl. | Gedruckt | Korrekt | Begründung |
|-----|----------|---------|------------|
| 4.54 | [δ^1i; δ^2i; **δ^2i**] | [δ^1i; δ^2i; **δ^3i**] = e_i | ∂a_α/∂u_ki = N_k,α e_i |
| 4.59 (1) | ½(N_k,α a_β**j** + N_k,β a_α**j**) | …a_β**i**…a_α**i** | LHS hängt von i ab |

Beide aus erster Ordnung zwingend.

---

## 6. Zweite Variation (NUR GNIA/Riks — NICHT lineare SS-Platte)
Membran (Eq 4.59, 2): ∂²E_αβ/∂u_ki∂u_lj = δ^ij · ½ (N_k,α N_l,β + N_k,β N_l,α)
Biegung (Eq 4.61, 2): ∂²κ_αβ/∂u_ki∂u_lj = − N_k,αβ ∂a_3i/∂u_lj − N_l,αβ ∂a_3j/∂u_ki
                                            − a_α,β · ∂²a₃/∂u_ki∂u_lj
∂²ā₃/∂u_ki∂u_lj = (N_k,1 N_l,2 − N_k,2 N_l,1)·[δ^i2δ^j3−δ^i3δ^j2; δ^i3δ^j1−δ^i1δ^j3; δ^i1δ^j2−δ^i2δ^j1]
∂²a₃ (Eq 4.57/4.58) laut Ludwig Num. Ex. 4.1 für Post-Buckling vernachlässigbar (approx. 2. Variation).

---

## 7. Validierungs-Gates (Phase-1-Disziplin)

1. **Membran-Rigid-Translation → 0**: garantiert durch PoU, Σ_k N_k,α = 0.
2. **B_m Komplex-Schritt:** ε_m(u_h+ε·θ) vs B_m·θ, ~1e-9.
3. **Biege-Rigid-Rotation → 0:** flach mit nur −N_k,αβ a_3i; Zylinder ERFORDERT δn → δn-Gate.
4. **B_b Komplex-Schritt:** κ(u_h+ε·θ) vs B_b·θ, ~1e-9.
5. **Konstant-Krümmungs-Patch:** M = D·κ → pinnt b_αβ-Vorzeichen gegen `_getBcov`.
6. **Uniaxial- + Reinschub-Patch:** N = A·ε → pinnt Voigt-Ordnung + Faktor 2 gegen `flat()`.
7. Erst wenn 1–6 grün: Element-Assembly + **SS-Platte (Ludwig 8.1)**, Konvergenz vs analytisch.

---

## Reihenfolge im Bau
B_m (§2) → Gates 1,2 → B_b ohne δn (§3.4 flach) → Gate 3 (flach) → K_e (§4) → Gates 5,6
→ SS-Platte (Gate 7). δn (§3.3) + Gate 3 (Zylinder) erst beim Zylinder-LBA.
