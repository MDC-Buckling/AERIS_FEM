"""Code_Aster command-file (.comm) + launcher (.export) builders.

The FEM counterpart to the IGA path's XML builder in
`scordelis_static.py::_build_input_xml`: same engine-agnostic ModelConfig
in, but emitting a Code_Aster study instead of a G+Smo bvp XML. The mesh
(with its named groups) comes from `scripts/meshing/gmsh_shells.py`; this
module wires those groups to boundary conditions, the section/material to
COQUE_3D, and the gravity load to FORCE_COQUE.

Group → physics mapping (must match gmsh_shells' physical groups):
    roof        COQUE_3D shell elements + FORCE_COQUE body force
    diaph_x0    DY=DZ=0   (diaphragm support, rigid in its own y-z plane)
    diaph_xL    DY=DZ=0
    corner_pin  DX=0      (kills the axial rigid-body mode the diaphragms leave)

The QoI (u_z at the free-edge midpoint) is NOT extracted in the .comm —
the displacement field is written to MED (unit 80) and the Python wrapper
picks the node nearest the target, reusing the meshio/h5py path the mesh
layer already validated. This keeps the .comm minimal (smaller failure
surface for the first validated solve) and the QoI logic in one language.
"""
from __future__ import annotations

from typing import Any, Dict


# Unit numbers wired consistently between the .comm and the .export.
UNITE_MESH_IN = 20    # LIRE_MAILLAGE  ← mesh.med
UNITE_RESU_OUT = 80   # IMPR_RESU      → result.med
UNITE_MESS = 6        # message log    → study.mess


def _mat(model: "ModelConfig"):  # noqa: F821
    """(E, ν) from materials[0] — mirrors scordelis_static (case() is
    cylinder-only). One material today; assignment chain plumbs in later."""
    m = model.materials[0]
    return float(m["E"]), float(m["nu"])


def _preamble(group_shell: str, family: str, E: float, nu: float,
              thickness: float, bc_groups: list[str],
              cara_vector: tuple | None = None) -> str:
    """LIRE_MAILLAGE + DEFI_GROUP (node groups for the BCs) + AFFE_MODELE +
    material + AFFE_CARA_ELEM. Shared by every shape; the caller appends its
    own load (CHAR) + solve. `family` is the gmsh element-family label, which
    maps 1:1 to the Code_Aster shell modelisation (DKT, DKTG, COQUE_3D, ...).
    COQUE_NCOU is only meaningful for the thick COQUE_3D family.

    `cara_vector` sets AFFE_CARA_ELEM/COQUE/VECTEUR — the reference direction
    the shell local frame is built from. Needed where the default (project
    global X) is degenerate, e.g. a cylinder whose surface normal is ∥X at
    θ=0; pass the axis (0,0,1), which is tangent everywhere. Only matters once
    a stress field (SIEF_ELGA) is computed (buckling), not for DEPL-only runs."""
    coque_ncou = ", COQUE_NCOU=1" if family.upper() == "COQUE_3D" else ""
    vec = f", VECTEUR={tuple(float(c) for c in cara_vector)}" if cara_vector else ""
    crea = ", ".join(f"_F(GROUP_MA='{g}')" for g in bc_groups)
    return f"""DEBUT(LANG='EN')

MAIL = LIRE_MAILLAGE(FORMAT='MED', UNITE={UNITE_MESH_IN})

# Node groups for the DDL_IMPO BCs, derived from the MED /FAS element groups.
MAIL = DEFI_GROUP(reuse=MAIL, MAILLAGE=MAIL, CREA_GROUP_NO=({crea}))

MODE = AFFE_MODELE(
    MAILLAGE=MAIL,
    AFFE=_F(GROUP_MA='{group_shell}', PHENOMENE='MECANIQUE', MODELISATION='{family}'),
)

ACIER = DEFI_MATERIAU(ELAS=_F(E={E:.10g}, NU={nu:.10g}))

CHMAT = AFFE_MATERIAU(MAILLAGE=MAIL, AFFE=_F(GROUP_MA='{group_shell}', MATER=ACIER))

CARA = AFFE_CARA_ELEM(
    MODELE=MODE,
    COQUE=_F(GROUP_MA='{group_shell}', EPAIS={thickness:.10g}{coque_ncou}{vec}),
)
"""


def _static_tail(char_block: str) -> str:
    """CHAR + MECA_STATIQUE + IMPR_RESU(DEPL) + FIN. Closes a linear-static
    study after a shape-specific _preamble."""
    return f"""
{char_block}

RESU = MECA_STATIQUE(
    MODELE=MODE, CHAM_MATER=CHMAT, CARA_ELEM=CARA,
    EXCIT=_F(CHARGE=CHAR),
)

IMPR_RESU(
    FORMAT='MED', UNITE={UNITE_RESU_OUT},
    RESU=_F(RESULTAT=RESU, NOM_CHAM=('DEPL',)),
)

FIN()
"""


def _comm_segment(model: "ModelConfig", manifest: Dict[str, Any]) -> str:  # noqa: F821
    """Scordelis-Lo roof (cylinder_segment): diaphragm supports on the two
    curved arcs (DY=DZ=0), a corner pin (DX=0) killing the axial RBM, and a
    uniform gravity body force via FORCE_COQUE FZ (force/area — the analogue
    of the IGA (0,0,-magnitude) body force)."""
    seg = model.geometry["cylinder_segment"]
    thickness = float(seg["t"])
    E, nu = _mat(model)
    family = str(manifest.get("element_family", "DKT")).upper()
    load = model.load
    if load.get("kind") != "gravity":
        raise SystemExit(
            f"cylinder_segment: only load.kind='gravity' is wired; "
            f"got {load.get('kind')!r}"
        )
    fz = -float(load.get("magnitude", 90.0))
    char = f"""CHAR = AFFE_CHAR_MECA(
    MODELE=MODE,
    DDL_IMPO=(
        _F(GROUP_NO='diaph_x0', DY=0.0, DZ=0.0),
        _F(GROUP_NO='diaph_xL', DY=0.0, DZ=0.0),
        _F(GROUP_NO='corner_pin', DX=0.0),
    ),
    FORCE_COQUE=_F(GROUP_MA='roof', FZ={fz:.10g}),
)"""
    return _preamble("roof", family, E, nu, thickness,
                     ["diaph_x0", "diaph_xL", "corner_pin"]) + _static_tail(char)


def _comm_cylinder(model: "ModelConfig", manifest: Dict[str, Any]) -> str:  # noqa: F821
    """Closed cylinder under axial end load: bottom rim fully clamped, top rim
    carrying the axial load. The total force F is applied as EQUAL nodal forces
    on the N top-rim nodes (FORCE_NODALE FZ = -F/N) — the resultant is exactly
    -F, giving a uniform membrane axial stress. We use FORCE_NODALE rather than
    FORCE_ARETE because gmsh's standalone edge SEGs aren't model elements, so
    FORCE_ARETE rejects them ("n'appartiennent pas au modèle")."""
    cyl = model.geometry["cylinder"]
    thickness = float(cyl["t"])
    E, nu = _mat(model)
    family = str(manifest.get("element_family", "DKT")).upper()
    load = model.load
    if load.get("kind") != "axial":
        raise SystemExit(
            f"cylinder: only load.kind='axial' is wired (Step 6); "
            f"got {load.get('kind')!r}"
        )
    n_top = int(manifest.get("top_node_count", 0))
    if n_top <= 0:
        raise SystemExit("cylinder: manifest has no top_node_count for the nodal load")
    F = float(load.get("magnitude", 1.0))
    fz_node = -F / n_top
    char = f"""CHAR = AFFE_CHAR_MECA(
    MODELE=MODE,
    DDL_IMPO=_F(GROUP_NO='bottom', DX=0.0, DY=0.0, DZ=0.0, DRX=0.0, DRY=0.0, DRZ=0.0),
    FORCE_NODALE=_F(GROUP_NO='top', FZ={fz_node:.10g}),
)"""
    return _preamble("shell", family, E, nu, thickness,
                     ["bottom", "top"]) + _static_tail(char)


def build_comm(model: "ModelConfig", manifest: Dict[str, Any]) -> str:  # noqa: F821
    """Assemble the MECA_STATIQUE command file, dispatching on geometry.shape.
    `manifest` is gmsh_shells.build_shell_mesh's return (its physical_groups
    are the GROUP_MA names the BCs reference)."""
    shape = model.geometry.get("shape")
    if shape == "cylinder_segment":
        return _comm_segment(model, manifest)
    if shape == "cylinder":
        return _comm_cylinder(model, manifest)
    raise SystemExit(f"build_comm: geometry.shape={shape!r} not wired")


def build_comm_gna(model: "ModelConfig", manifest: Dict[str, Any],  # noqa: F821
                   nsteps: int = 20) -> str:
    """Geometrically-nonlinear static (GNA) of the Scordelis-Lo roof:
    STAT_NON_LINE with large-displacement kinematics (GROT_GDEP), the gravity
    load ramped over the pseudo-time [0,1] in `nsteps` increments. At the
    Scordelis load the deflection is small relative to R, so GNA ≈ LSA — the
    degenerate check that the nonlinear path correctly reduces to linear."""
    seg = model.geometry["cylinder_segment"]
    thickness = float(seg["t"])
    E, nu = _mat(model)
    # GNA uses DKTG (discrete-Kirchhoff with membrane + drilling stiffness),
    # not plain DKT: DKT's null drilling DOF makes the nonlinear tangent
    # singular → Newton can't converge. DKTG shares the same TRIA3 mesh.
    family = "DKTG"
    load = model.load
    if load.get("kind") != "gravity":
        raise SystemExit(
            f"cylinder_segment GNA: only load.kind='gravity' is wired; "
            f"got {load.get('kind')!r}"
        )
    fz = -float(load.get("magnitude", 90.0))
    pre = _preamble("roof", family, E, nu, thickness,
                    ["diaph_x0", "diaph_xL", "corner_pin"])
    return pre + f"""
CHAR = AFFE_CHAR_MECA(
    MODELE=MODE,
    DDL_IMPO=(
        _F(GROUP_NO='diaph_x0', DY=0.0, DZ=0.0),
        _F(GROUP_NO='diaph_xL', DY=0.0, DZ=0.0),
        _F(GROUP_NO='corner_pin', DX=0.0),
    ),
    FORCE_COQUE=_F(GROUP_MA='roof', FZ={fz:.10g}),
)

LREEL = DEFI_LIST_REEL(DEBUT=0.0, INTERVALLE=_F(JUSQU_A=1.0, NOMBRE={int(nsteps)}))
# Auto time-stepping: on a non-converged Newton step, cut the increment
# (DECOUPE) and retry — the standard robustness recipe for GNA.
DLIST = DEFI_LIST_INST(
    METHODE='AUTO',
    DEFI_LIST=_F(LIST_INST=LREEL),
    ECHEC=_F(EVENEMENT='ERREUR', ACTION='DECOUPE',
             SUBD_METHODE='MANUEL', SUBD_PAS=4, SUBD_NIVEAU=5),
)
RAMPE = DEFI_FONCTION(
    NOM_PARA='INST', VALE=(0.0, 0.0, 1.0, 1.0),
    PROL_DROITE='CONSTANT', PROL_GAUCHE='CONSTANT',
)

RESU = STAT_NON_LINE(
    MODELE=MODE, CHAM_MATER=CHMAT, CARA_ELEM=CARA,
    EXCIT=_F(CHARGE=CHAR, FONC_MULT=RAMPE),
    COMPORTEMENT=_F(RELATION='ELAS', DEFORMATION='GROT_GDEP'),
    INCREMENT=_F(LIST_INST=DLIST),
    NEWTON=_F(MATRICE='TANGENTE', REAC_ITER=1),
    # 1e-5, not 1e-6: the solution is essentially converged by iteration 2
    # (relative residual ~4e-6), but a slowly-decaying drilling mode creeps
    # just above 1e-6 for hundreds of iterations. 1e-5 converges in 2 iters.
    CONVERGENCE=_F(RESI_GLOB_RELA=1e-5, ITER_GLOB_MAXI=50),
)

IMPR_RESU(
    FORMAT='MED', UNITE={UNITE_RESU_OUT},
    RESU=_F(RESULTAT=RESU, NOM_CHAM=('DEPL',), INST=1.0),
)

FIN()
"""


def build_comm_buckling(model: "ModelConfig", manifest: Dict[str, Any],  # noqa: F821
                        work_dir: str = "/work", nmodes: int = 5,
                        f_ref: float = 1.0) -> str:
    """Linear buckling (LBA) of the closed cylinder under axial load. Classic
    Code_Aster eigen-buckling chain:
      1. MECA_STATIQUE under a reference axial load → pre-buckling stress
         (SIEF_ELGA) — the same clamped-bottom / nodal-top setup as the static
         path, so the pre-stress is the validated membrane field.
      2. RIGI_MECA (with the Dirichlet BCs) + RIGI_GEOM (from that stress) →
         assembled K and K_geom.
      3. CALC_MODES(TYPE_RESU='MODE_FLAMB') → critical load factors λ. The
         applied load is F_ref, so the buckling load is F_cr = λ₁·F_ref.
    The λ list is dumped to charcrit.json (via the comm's own Python) for the
    wrapper to turn into σ_cr and compare against the classical estimate."""
    cyl = model.geometry["cylinder"]
    thickness = float(cyl["t"])
    E, nu = _mat(model)
    family = str(manifest.get("element_family", "DKT")).upper()
    n_top = int(manifest.get("top_node_count", 0))
    if n_top <= 0:
        raise SystemExit("cylinder buckling: manifest has no top_node_count")
    # f_ref is scaled by the wrapper to the classical F_cr estimate so the
    # critical load factor λ₁ ≈ 1 — the eigensolver finds it near 1 instead of
    # at ~thousands (where OPTION='PLUS_PETITE' returns 0 modes).
    fz_node = -float(f_ref) / n_top
    # VECTEUR=(0,0,1): the cylinder axis is tangent to the shell everywhere, so
    # the local frame is well-defined (default global-X projection is normal to
    # the surface at θ=0 → PLATE1_40). Needed once SIEF_ELGA is computed.
    pre = _preamble("shell", family, E, nu, thickness, ["bottom", "top"],
                    cara_vector=(0.0, 0.0, 1.0))
    return pre + f"""
# Dirichlet BC (kinematic) and the axial reference load kept separate so the
# stiffness assembly takes only the BC, the static solve takes both. Clamped
# bottom / free loaded top (mirrors the IGA cylinder_lba clamped_neumann).
# NOTE: simply-supported ends (both rims DX=DY=0) are the classical-σ_cr BC,
# but that produces a DENSE clustered spectrum the shift-invert eigensolver
# here doesn't resolve (CENTRE applies a 0 shift → 0 modes; BANDE finds 800+
# and diverges). Cracking the classical match is a dedicated Code_Aster
# eigensolver-tuning task — see the honest note in code_aster_buckling.py.
CHBC = AFFE_CHAR_MECA(
    MODELE=MODE,
    DDL_IMPO=_F(GROUP_NO='bottom', DX=0.0, DY=0.0, DZ=0.0, DRX=0.0, DRY=0.0, DRZ=0.0),
)
CHLO = AFFE_CHAR_MECA(
    MODELE=MODE,
    FORCE_NODALE=_F(GROUP_NO='top', FZ={fz_node:.10g}),
)

RESU = MECA_STATIQUE(
    MODELE=MODE, CHAM_MATER=CHMAT, CARA_ELEM=CARA,
    EXCIT=(_F(CHARGE=CHBC), _F(CHARGE=CHLO)),
)
RESU = CALC_CHAMP(reuse=RESU, RESULTAT=RESU, CONTRAINTE='SIEF_ELGA')

SIG = CREA_CHAMP(
    OPERATION='EXTR', TYPE_CHAM='ELGA_SIEF_R',
    RESULTAT=RESU, NOM_CHAM='SIEF_ELGA', NUME_ORDRE=1,
)

MEL_R = CALC_MATR_ELEM(
    OPTION='RIGI_MECA', MODELE=MODE, CHAM_MATER=CHMAT,
    CARA_ELEM=CARA, CHARGE=CHBC,
)
MEL_G = CALC_MATR_ELEM(
    OPTION='RIGI_GEOM', MODELE=MODE, CARA_ELEM=CARA, SIEF_ELGA=SIG,
)

NUM = NUME_DDL(MATR_RIGI=MEL_R)
K_AS = ASSE_MATRICE(MATR_ELEM=MEL_R, NUME_DDL=NUM)
G_AS = ASSE_MATRICE(MATR_ELEM=MEL_G, NUME_DDL=NUM)

# Axial-cylinder buckling has a DENSE cluster of modes near the critical load
# (many circumferential-wave combinations at almost the same λ). 'BANDE' would
# compute all of them (hundreds) and not converge; 'PLUS_PETITE' returns
# nothing. Shift-invert ('CENTRE') finds just the NMAX nearest a shift — and
# the shift must sit OFF the cluster: f_ref is scaled so the cluster is ≈ 1.0,
# so we shift at 0.7 (below it). Shifting AT 1.0 makes (K + σ·K_geom) singular
# → 0 modes. STURM='NON' skips the a-posteriori check that trips on multiples.
FLAMB = CALC_MODES(
    MATR_RIGI=K_AS, MATR_RIGI_GEOM=G_AS,
    OPTION='BANDE', TYPE_RESU='MODE_FLAMB',
    CALC_CHAR_CRIT=_F(CHAR_CRIT=(0.0, 3.0)),
    VERI_MODE=_F(STURM='NON'),
)

# Dump the critical load factors λ for the wrapper (the .comm is Python).
_tab = RECU_TABLE(CO=FLAMB, NOM_PARA='CHAR_CRIT')
_vals = _tab.EXTR_TABLE().values()['CHAR_CRIT']
import json as _json
with open('{work_dir}/charcrit.json', 'w') as _f:
    _json.dump([float(v) for v in _vals], _f)

FIN()
"""


def build_export(work_dir: str = "/work",
                 time_limit_s: int = 900,
                 memory_mb: int = 2048) -> str:
    """The as_run/run_aster launcher file. Maps the study's logical units to
    the files on the /work volume the wrapper wrote.

    F-line columns: <kind> <path> <D|R> <unit>
      D = data (input, read by the study), R = result (written by the study).
    'comm' unit 1, 'mmed' the input MED mesh, 'med' the result MED, 'mess'
    the message log."""
    return f"""P actions make_etude
P version stable
P mode batch
P time_limit {int(time_limit_s)}
P memory_limit {int(memory_mb)}
F comm {work_dir}/study.comm D 1
F mmed {work_dir}/mesh.med D {UNITE_MESH_IN}
F med {work_dir}/result.med R {UNITE_RESU_OUT}
F mess {work_dir}/study.mess R {UNITE_MESS}
"""
