# Aeris — G+Smo build image for thin-shell buckling research
#
# Builds G+Smo (Geometry + Simulation Modules) with:
#   - gsKLShell             (Kirchhoff-Love shell elements)
#   - gsStructuralAnalysis  (buckling / arc-length / gsAPALM)
#   - gsUnstructuredSplines (multi-patch coupling)
#
# NOTE on pygismo: GISMO_WITH_PYBIND11 is OFF for now. With v25.07.0 plus
# the optional shell modules, the pygismo binding fails to compile against
# both apt pybind11-dev 2.9.1 and pip pybind11 2.13.6 — gsEigen namespace
# clash in src/misc/gsPyBind11.cpp. The smoke test exercises gsKLShell via
# a shipped C++ executable instead, which is what the session brief allows
# as fallback. See README.md "STATUS" for the next-session plan.
#
# Build context = project root. Source comes from ./external/gismo (a
# git submodule pinned to v25.07.0).
#
# Optional submodules (gsKLShell etc.) are *fetched at CMake-configure
# time* from github.com/gismo/<name>.git via gismo_fetch_module() — see
# external/gismo/cmake/gsFetch.cmake. They are pulled at HEAD; pinning
# them is a TODO in README.md "STATUS".

FROM ubuntu:22.04

LABEL org.opencontainers.image.title="aeris-gismo" \
      org.opencontainers.image.description="G+Smo with shell modules + pygismo, for the Aeris FEM project" \
      org.opencontainers.image.licenses="MPL-2.0"

ARG DEBIAN_FRONTEND=noninteractive

# ----- Build-time config (overridable with --build-arg) -----------------------
ARG CMAKE_BUILD_TYPE=Release
ARG CMAKE_CXX_STANDARD=17
ARG GISMO_OPTIONAL="gsKLShell;gsStructuralAnalysis;gsUnstructuredSplines;gsOptim"
ARG GISMO_WITH_PYBIND11=OFF
ARG GISMO_WITH_OPENMP=ON
ARG GISMO_BUILD_EXAMPLES=ON
ARG GISMO_BUILD_LIB=ON
ARG BUILD_PARALLEL=4

# ----- Layer 1: system packages (cached unless this list changes) ------------
RUN apt-get update -q && \
    apt-get install --no-install-recommends -yq \
        ca-certificates \
        build-essential \
        g++-11 \
        gcc-11 \
        gfortran-11 \
        cmake \
        git \
        wget \
        pkg-config \
        libboost-all-dev \
        libopenblas-dev \
        liblapack-dev \
        liblapacke-dev \
        zlib1g-dev \
        python3 \
        python3-dev \
        python3-pip \
        python3-numpy \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-11 100 \
    && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-11 100 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV CC=gcc CXX=g++

# ----- Layer 2: G+Smo source (invalidated on any source change) --------------
WORKDIR /opt
COPY external/gismo /opt/gismo

# ----- Layer 3: configure + build --------------------------------------------
# G+Smo will git-clone the optional modules listed in GISMO_OPTIONAL into
# /opt/gismo/optional/<name> during the CMake configure step (needs network
# at build time — Docker buildx provides that by default).
RUN mkdir /opt/gismo/build && cd /opt/gismo/build && \
    cmake .. \
        -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE} \
        -DCMAKE_CXX_STANDARD=${CMAKE_CXX_STANDARD} \
        -DGISMO_BUILD_LIB=${GISMO_BUILD_LIB} \
        -DGISMO_BUILD_EXAMPLES=${GISMO_BUILD_EXAMPLES} \
        -DGISMO_WITH_OPENMP=${GISMO_WITH_OPENMP} \
        -DGISMO_WITH_PYBIND11=${GISMO_WITH_PYBIND11} \
        -DGISMO_OPTIONAL="${GISMO_OPTIONAL}" \
        -DCMAKE_INSTALL_PREFIX=/opt/gismo/install \
    && cmake --build . --parallel ${BUILD_PARALLEL} \
    && echo "--- Build artefacts under /opt/gismo/build ---" \
    && ls -la /opt/gismo/build/lib | head -40 \
    && ls /opt/gismo/build/bin | wc -l

# Capture the actual commit hashes of the fetched optional modules so we can
# pin them next session (printed during build, also written to /opt/gismo/.pins).
RUN set -eu; \
    : > /opt/gismo/.pins; \
    for d in /opt/gismo/optional/*/; do \
        name=$(basename "$d"); \
        if [ -d "$d/.git" ]; then \
            hash=$(cd "$d" && git rev-parse HEAD 2>/dev/null || echo "no-git"); \
            echo "$name $hash" | tee -a /opt/gismo/.pins; \
        fi; \
    done

# ----- Layer 4: convenience env --------------------------------------------
# (pygismo is OFF for now — PYTHONPATH will become relevant once it builds.)
ENV PATH=/opt/gismo/build/bin:${PATH}

# ----- Layer 5: project scripts (cheap layer for iteration) ------------------
COPY scripts /aeris/scripts
WORKDIR /aeris

# Default: drop into shell. Override with `python3 scripts/smoke_test.py`.
CMD ["/bin/bash"]
