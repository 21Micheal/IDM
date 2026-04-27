"""
apps/documents/ocr/preprocessing.py

OpenCV-based image pre-processing pipeline for scanned documents.

Every function accepts and returns a numpy array (BGR or grayscale as noted).
The pipeline is designed to be composable — call prepare_image_for_ocr() for
the full sequence, or call individual stages if you need custom control.

Stage order
───────────
1. colour_to_gray          — collapse channels; Tesseract works on grayscale
2. correct_resolution      — upscale images below 300 DPI to a target DPI
3. denoise                 — remove sensor noise without blurring text edges
4. correct_skew            — rotate to straighten text lines (deskew)
5. binarize                — adaptive threshold → crisp black/white text
6. remove_borders          — strip solid black/white borders added by scanners
7. scale_for_ocr           — ensure the final image is ≥ 300 DPI equivalent

Design notes
────────────
• All operations are non-destructive; they return new arrays.
• correct_skew() uses the Hough line transform rather than the projection
  profile method — more robust on documents with sparse text or heavy logos.
• binarize() uses CLAHE (contrast-limited adaptive histogram equalisation)
  before thresholding, which handles uneven illumination from phone cameras.
• No GPU required — all operations run on CPU via OpenCV.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

# Tesseract accuracy degrades below ~200 DPI. We target 300 as the minimum.
_MIN_OCR_DPI = 300
_TARGET_OCR_DPI = 300

# Skew correction: ignore rotations smaller than this (likely detection noise).
_SKEW_THRESHOLD_DEG = 0.3
# Cap correction at ±15°; larger angles are usually portrait/landscape confusion,
# not true document skew.
_MAX_SKEW_DEG = 15.0


# ── Public entry point ─────────────────────────────────────────────────────────


def prepare_image_for_ocr(
    image: np.ndarray,
    dpi: int = 0,
    *,
    denoise: bool = True,
    deskew: bool = True,
    binarize: bool = True,
    remove_borders: bool = True,
) -> np.ndarray:
    """
    Run the full pre-processing pipeline on a single page image.

    Parameters
    ──────────
    image          : BGR or grayscale numpy array (from Pillow/pdf2image/cv2).
    dpi            : Declared DPI of the source image. 0 = unknown (skip
                     resolution correction, rely on scale_for_ocr instead).
    denoise        : Apply non-local means denoising.
    deskew         : Correct document rotation.
    binarize       : Apply adaptive binarization.
    remove_borders : Strip scanner borders.

    Returns a grayscale uint8 numpy array ready for pytesseract.
    """
    img = colour_to_gray(image)

    if dpi and dpi > 0:
        img = correct_resolution(img, source_dpi=dpi, target_dpi=_TARGET_OCR_DPI)

    if denoise:
        img = denoise_image(img)

    if deskew:
        img = correct_skew(img)

    if binarize:
        img = binarize_image(img)

    if remove_borders:
        img = remove_scanner_borders(img)

    # Final safety: ensure image is large enough for Tesseract
    img = scale_for_ocr(img)

    return img


# ── Stage implementations ──────────────────────────────────────────────────────


def colour_to_gray(image: np.ndarray) -> np.ndarray:
    """Convert BGR or RGBA to grayscale. Noop if already grayscale."""
    if image.ndim == 2:
        return image  # already grayscale
    if image.shape[2] == 4:
        # RGBA → BGR first
        image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def correct_resolution(
    image: np.ndarray,
    source_dpi: int,
    target_dpi: int = _TARGET_OCR_DPI,
) -> np.ndarray:
    """
    Upscale image if source DPI is below target.

    Only upscales — never downscales — to avoid losing resolution on
    already-high-DPI scans. Uses INTER_CUBIC for quality upscaling.
    """
    if source_dpi <= 0 or source_dpi >= target_dpi:
        return image

    scale = target_dpi / source_dpi
    h, w = image.shape[:2]
    new_w = int(w * scale)
    new_h = int(h * scale)
    logger.debug(
        "correct_resolution: scaling %dx%d → %dx%d (%.1fx, %d→%d dpi)",
        w, h, new_w, new_h, scale, source_dpi, target_dpi,
    )
    return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)


def denoise_image(image: np.ndarray) -> np.ndarray:
    """
    Apply Non-Local Means denoising.

    h=10 is conservative — strong enough to remove scanner grain and JPEG
    compression artefacts without blurring fine strokes in small fonts.
    """
    return cv2.fastNlMeansDenoising(image, h=10, templateWindowSize=7, searchWindowSize=21)


def correct_skew(image: np.ndarray) -> np.ndarray:
    """
    Detect and correct document rotation using the Hough line transform.

    Strategy
    ────────
    1. Edge detection (Canny) to find strong edges.
    2. Probabilistic Hough lines on the edge map.
    3. Compute the median angle of lines close to horizontal.
    4. Rotate the image by the negative of that angle.

    Returns the original image unchanged if skew is below _SKEW_THRESHOLD_DEG
    or above _MAX_SKEW_DEG (to avoid mis-correcting portrait/landscape pages).
    """
    # Work on an inverted binary copy so dark text on white = white blobs
    _, binary = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Detect edges
    edges = cv2.Canny(binary, 50, 150, apertureSize=3)

    # Hough transform — longer min line length = more reliable angle estimate
    h, w = image.shape
    min_line_len = max(50, w // 8)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=80,
        minLineLength=min_line_len,
        maxLineGap=10,
    )

    if lines is None or len(lines) == 0:
        return image

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        if x2 == x1:
            continue  # vertical line — skip
        angle_deg = math.degrees(math.atan2(y2 - y1, x2 - x1))
        # Only consider near-horizontal lines (text baselines)
        if abs(angle_deg) < 45:
            angles.append(angle_deg)

    if not angles:
        return image

    skew = float(np.median(angles))
    logger.debug("correct_skew: detected %.2f°", skew)

    if abs(skew) < _SKEW_THRESHOLD_DEG or abs(skew) > _MAX_SKEW_DEG:
        return image

    # Rotate about the image centre, preserving dimensions
    centre = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(centre, skew, 1.0)
    rotated = cv2.warpAffine(
        image, M, (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    logger.debug("correct_skew: corrected by %.2f°", skew)
    return rotated


def binarize_image(image: np.ndarray) -> np.ndarray:
    """
    Convert to a crisp black-and-white image using CLAHE + adaptive threshold.

    CLAHE (Contrast Limited Adaptive Histogram Equalisation) normalises uneven
    illumination first, which is the main cause of OCR failure on phone-camera
    shots (shadow on one side, glare on the other).

    Adaptive threshold is then used instead of a global one so that local
    contrast variations (e.g. faded areas, watermarks) don't cause either
    whiteout or blackout.
    """
    # CLAHE to equalise local contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    equalised = clahe.apply(image)

    # Adaptive Gaussian threshold
    binary = cv2.adaptiveThreshold(
        equalised,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=31,   # must be odd; larger = handles bigger illumination gradients
        C=10,           # constant subtracted from mean; positive = whiter background
    )
    return binary


def remove_scanner_borders(image: np.ndarray) -> np.ndarray:
    """
    Crop solid-colour borders introduced by flatbed scanners.

    Detects near-uniform rows/columns at the image edges and removes them.
    Leaves at least 95% of the image intact to avoid cutting real content.
    """
    h, w = image.shape

    def _uniform(arr: np.ndarray, threshold: int = 250) -> bool:
        """True if the row/column is nearly all white (or all black)."""
        return bool(np.mean(arr) > threshold or np.mean(arr) < 5)

    top = 0
    while top < h // 20 and _uniform(image[top, :]):
        top += 1

    bottom = h - 1
    while bottom > h - h // 20 and _uniform(image[bottom, :]):
        bottom -= 1

    left = 0
    while left < w // 20 and _uniform(image[:, left]):
        left += 1

    right = w - 1
    while right > w - w // 20 and _uniform(image[:, right]):
        right -= 1

    if top >= bottom or left >= right:
        return image  # nothing useful would remain

    return image[top : bottom + 1, left : right + 1]


def scale_for_ocr(image: np.ndarray, min_height_px: int = 1000) -> np.ndarray:
    """
    Ensure the image is tall enough for reliable Tesseract recognition.

    Tesseract's default neural network model (LSTM) works best when the
    x-height of lowercase letters is ≥ 20 px. At 300 DPI that requires
    the document to be at least 1000 px tall for A4/letter.

    Only upscales; never downscales.
    """
    h, w = image.shape[:2]
    if h >= min_height_px:
        return image
    scale = min_height_px / h
    new_w = int(w * scale)
    new_h = int(h * scale)
    return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)


# ── Pillow ↔ OpenCV conversion helpers ────────────────────────────────────────


def pil_to_cv2(pil_image) -> np.ndarray:
    """Convert a PIL Image to a numpy array (BGR channel order)."""
    from PIL import Image
    img = pil_image.convert("RGB")
    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def cv2_to_pil(cv2_image: np.ndarray):
    """Convert a grayscale or BGR numpy array to a PIL Image."""
    from PIL import Image
    if cv2_image.ndim == 2:
        return Image.fromarray(cv2_image)
    rgb = cv2.cvtColor(cv2_image, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)