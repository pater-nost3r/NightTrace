"""NightTrace server core: stateless access to SPHEREx Level 2 frames.

Everything here works on HTTP range requests to the public IRSA cloud copy of
SPHEREx (AWS Open Data, bucket ``nasa-irsa-spherex``) and needs only NumPy.
No state is kept between requests, so the code fits serverless functions.
"""

VERSION = "1.0.0"
