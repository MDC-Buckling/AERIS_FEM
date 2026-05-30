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


def build_comm(model: "ModelConfig", manifest: Dict[str, Any]) -> str:  # noqa: F821
    """Assemble the MECA_STATIQUE command file for the Scordelis-Lo roof.

    `model` is a ModelConfig (cylinder_segment + static + gravity); `manifest`
    is the dict returned by gmsh_shells.build_shell_mesh (its physical_groups
    are the GROUP_MA names referenced below)."""
    seg = model.geometry["cylinder_segment"]
    thickness = float(seg["t"])

    # Material: mirror scordelis_static — pull materials[0] directly (case()
    # is cylinder-only). One material/section today; the assignment chain is
    # plumbed through when multi-material segments land.
    mat = model.materials[0]
    E = float(mat["E"])
    nu = float(mat["nu"])

    load = model.load
    if load.get("kind") != "gravity":
        raise SystemExit(
            "code_aster_static: only load.kind='gravity' is wired (Step 3); "
            f"got {load.get('kind')!r}"
        )
    # FORCE_COQUE FZ is a force per unit shell AREA in the global frame —
    # the exact analogue of the IGA path's (0,0,-magnitude) body force, so
    # the two engines solve the identical physical load. Scordelis uses 90.
    magnitude = float(load.get("magnitude", 90.0))
    fz = -magnitude

    # MODELISATION is the gmsh element-family label, which maps 1:1 to the
    # Code_Aster shell modelisation name (DKT, DKTG, COQUE_3D, ...). DKT is
    # the validated default. COQUE_NCOU (through-thickness integration layers)
    # is only meaningful for the thick COQUE_3D family, not for DKT.
    family = str(manifest.get("element_family", "DKT")).upper()
    modelisation = family
    coque_ncou = ", COQUE_NCOU=1" if family == "COQUE_3D" else ""

    return f"""DEBUT(LANG='EN')

MAIL = LIRE_MAILLAGE(FORMAT='MED', UNITE={UNITE_MESH_IN})

# Node groups for the DDL_IMPO BCs are derived from the (element/vertex)
# groups the mesh-layer wrote into the MED /FAS families.
MAIL = DEFI_GROUP(
    reuse=MAIL, MAILLAGE=MAIL,
    CREA_GROUP_NO=(
        _F(GROUP_MA='diaph_x0'),
        _F(GROUP_MA='diaph_xL'),
        _F(GROUP_MA='corner_pin'),
    ),
)

MODE = AFFE_MODELE(
    MAILLAGE=MAIL,
    AFFE=_F(GROUP_MA='roof', PHENOMENE='MECANIQUE', MODELISATION='{modelisation}'),
)

ACIER = DEFI_MATERIAU(ELAS=_F(E={E:.10g}, NU={nu:.10g}))

CHMAT = AFFE_MATERIAU(MAILLAGE=MAIL, AFFE=_F(GROUP_MA='roof', MATER=ACIER))

CARA = AFFE_CARA_ELEM(
    MODELE=MODE,
    COQUE=_F(GROUP_MA='roof', EPAIS={thickness:.10g}{coque_ncou}),
)

CHAR = AFFE_CHAR_MECA(
    MODELE=MODE,
    DDL_IMPO=(
        _F(GROUP_NO='diaph_x0', DY=0.0, DZ=0.0),
        _F(GROUP_NO='diaph_xL', DY=0.0, DZ=0.0),
        _F(GROUP_NO='corner_pin', DX=0.0),
    ),
    FORCE_COQUE=_F(GROUP_MA='roof', FZ={fz:.10g}),
)

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
