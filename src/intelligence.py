"""
Intelligenz-Modul v2.0 für Video-Analyse.

Features:
- Gesichtserkennung für Smart Zoom (OpenCV Haar Cascade)
- Object Tracking (KCF/CSRT Tracker)
- Sentiment-Analyse für Emojis
- Szenen-Erkennung
- Motion Detection
"""

import cv2
import numpy as np
import sys
from dataclasses import dataclass
from typing import Optional, List, Tuple
import os
from pathlib import Path


@dataclass
class FaceRegion:
    """Erkanntes Gesicht im Frame."""
    x: int
    y: int
    width: int
    height: int
    confidence: float

    @property
    def center(self) -> tuple[int, int]:
        return (self.x + self.width // 2, self.y + self.height // 2)

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.width, self.height)


@dataclass
class TrackedObject:
    """Ein verfolgtes Objekt."""
    id: int
    x: int
    y: int
    width: int
    height: int
    label: str = "object"

    @property
    def center(self) -> tuple[int, int]:
        return (self.x + self.width // 2, self.y + self.height // 2)

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.width, self.height)


@dataclass
class FrameAnalysis:
    """Analyse eines einzelnen Frames."""
    faces: list[FaceRegion]
    has_motion: bool
    brightness: float
    dominant_region: Optional[tuple[int, int]]


@dataclass
class Sentiment:
    """Sentiment-Analyse eines Textes."""
    score: float
    emotion: str
    emoji: str


class FaceDetector:
    """Gesichtserkennung mit OpenCV Haar Cascade (robust & zuverlässig)."""

    def __init__(self):
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        self.detector = cv2.CascadeClassifier(cascade_path)

        # Profil-Gesichtserkennung
        profile_path = cv2.data.haarcascades + 'haarcascade_profileface.xml'
        self.profile_detector = cv2.CascadeClassifier(profile_path)

    def detect_faces(self, frame: np.ndarray) -> list[FaceRegion]:
        """
        Erkennt Gesichter im Frame.

        Args:
            frame: BGR numpy array

        Returns:
            Liste von FaceRegion Objekten
        """
        if len(frame.shape) == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame

        # Frontal-Gesichter
        faces_rect = self.detector.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30)
        )

        faces = []
        for (x, y, w, h) in faces_rect:
            faces.append(FaceRegion(
                x=x, y=y, width=w, height=h, confidence=1.0
            ))

        # Falls keine frontalen Gesichter, versuche Profile
        if not faces:
            profile_rect = self.profile_detector.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
            )
            for (x, y, w, h) in profile_rect:
                faces.append(FaceRegion(
                    x=x, y=y, width=w, height=h, confidence=0.8
                ))

        return faces

    def get_primary_face(self, frame: np.ndarray) -> Optional[FaceRegion]:
        """Gibt das größte/prominenteste Gesicht zurück."""
        faces = self.detect_faces(frame)
        if not faces:
            return None
        return max(faces, key=lambda f: f.area)

    def track_faces_in_video(self, video_path: str, sample_interval: float = 0.5) -> List[Tuple[float, FaceRegion]]:
        """
        Verfolgt Gesichter über ein Video.

        Args:
            video_path: Pfad zum Video
            sample_interval: Intervall zwischen Samples in Sekunden

        Returns:
            Liste von (timestamp, FaceRegion) Tuples
        """
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_interval = int(fps * sample_interval)

        results = []
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % frame_interval == 0:
                face = self.get_primary_face(frame)
                if face:
                    timestamp = frame_count / fps
                    results.append((timestamp, face))

            frame_count += 1

        cap.release()
        return results

    def close(self):
        pass

    def get_face_positions_for_effects(self, video_path: str, sample_interval: float = 0.2) -> list:
        """
        Gibt Gesichtspositionen im Format für Effekte zurück.

        Returns:
            Liste von (time, x, y, w, h) Tuples
        """
        tracked = self.track_faces_in_video(video_path, sample_interval)
        return [(t, f.x, f.y, f.width, f.height) for t, f in tracked]


class ObjectTracker:
    """
    Object Tracking mit OpenCV.
    Unterstützt verschiedene Tracking-Algorithmen.
    """

    def __init__(self, tracker_type: str = 'kcf'):
        """
        Args:
            tracker_type: 'kcf' (schnell), 'csrt' (genau), 'mil' (robust)
        """
        self.tracker_type = tracker_type
        self.trackers = {}
        self.next_id = 0

    def _create_tracker(self):
        """Erstellt einen neuen Tracker (kompatibel mit verschiedenen OpenCV Versionen)."""
        tracker = None

        # Versuche neue API (OpenCV 4.5+)
        try:
            if self.tracker_type == 'kcf':
                tracker = cv2.TrackerKCF.create()
            elif self.tracker_type == 'csrt':
                tracker = cv2.TrackerCSRT.create()
            elif self.tracker_type == 'mil':
                tracker = cv2.TrackerMIL.create()
        except AttributeError:
            pass

        # Versuche legacy API
        if tracker is None:
            try:
                if hasattr(cv2, 'legacy'):
                    if self.tracker_type == 'kcf':
                        tracker = cv2.legacy.TrackerKCF_create()
                    elif self.tracker_type == 'csrt':
                        tracker = cv2.legacy.TrackerCSRT_create()
                    elif self.tracker_type == 'mil':
                        tracker = cv2.legacy.TrackerMIL_create()
            except AttributeError:
                pass

        # Fallback: Kein Tracker
        return tracker

    def start_tracking(self, frame: np.ndarray, bbox: tuple, label: str = "object") -> int:
        """
        Startet Tracking für ein Objekt.

        Args:
            frame: Aktueller Frame
            bbox: (x, y, width, height)
            label: Objekt-Label

        Returns:
            Tracker ID oder -1 wenn Tracker nicht verfügbar
        """
        tracker = self._create_tracker()
        if tracker is None:
            return -1
        tracker.init(frame, bbox)

        tracker_id = self.next_id
        self.trackers[tracker_id] = {
            'tracker': tracker,
            'label': label,
            'bbox': bbox,
            'active': True
        }
        self.next_id += 1

        return tracker_id

    def update(self, frame: np.ndarray) -> List[TrackedObject]:
        """
        Aktualisiert alle Tracker.

        Args:
            frame: Aktueller Frame

        Returns:
            Liste von TrackedObject
        """
        results = []

        for tracker_id, data in list(self.trackers.items()):
            if not data['active']:
                continue

            success, bbox = data['tracker'].update(frame)

            if success:
                x, y, w, h = [int(v) for v in bbox]
                data['bbox'] = (x, y, w, h)

                results.append(TrackedObject(
                    id=tracker_id,
                    x=x, y=y,
                    width=w, height=h,
                    label=data['label']
                ))
            else:
                data['active'] = False

        return results

    def stop_tracking(self, tracker_id: int):
        """Stoppt Tracking für ein Objekt."""
        if tracker_id in self.trackers:
            self.trackers[tracker_id]['active'] = False

    def reset(self):
        """Setzt alle Tracker zurück."""
        self.trackers = {}
        self.next_id = 0


class MotionDetector:
    """Erkennt Bewegung zwischen Frames."""

    def __init__(self, threshold: float = 25.0, blur_size: int = 21):
        self.threshold = threshold
        self.blur_size = blur_size
        self._prev_frame = None
        self._motion_mask = None

    def detect(self, frame: np.ndarray) -> Tuple[bool, Optional[np.ndarray]]:
        """
        Erkennt Bewegung im Frame.

        Args:
            frame: Aktueller Frame

        Returns:
            (has_motion, motion_mask)
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        gray = cv2.GaussianBlur(gray, (self.blur_size, self.blur_size), 0)

        if self._prev_frame is None:
            self._prev_frame = gray
            return False, None

        # Differenz berechnen
        diff = cv2.absdiff(self._prev_frame, gray)
        _, thresh = cv2.threshold(diff, self.threshold, 255, cv2.THRESH_BINARY)

        # Morphologische Operationen für Rauschentfernung
        kernel = np.ones((5, 5), np.uint8)
        thresh = cv2.dilate(thresh, kernel, iterations=2)

        self._prev_frame = gray
        self._motion_mask = thresh

        # Bewegung erkannt wenn genug Pixel sich geändert haben
        motion_percent = np.sum(thresh > 0) / thresh.size
        has_motion = motion_percent > 0.01  # Mindestens 1% Bewegung

        return has_motion, thresh

    def get_motion_regions(self, frame: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """
        Gibt Regionen mit Bewegung zurück.

        Returns:
            Liste von (x, y, w, h) Bounding Boxes
        """
        has_motion, mask = self.detect(frame)
        if not has_motion or mask is None:
            return []

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        regions = []
        for contour in contours:
            if cv2.contourArea(contour) > 500:  # Mindestgröße
                x, y, w, h = cv2.boundingRect(contour)
                regions.append((x, y, w, h))

        return regions

    def reset(self):
        """Setzt den Detektor zurück."""
        self._prev_frame = None
        self._motion_mask = None


class FrameAnalyzer:
    """Analysiert Video-Frames für intelligente Effekte."""

    def __init__(self):
        self.face_detector = FaceDetector()
        self.motion_detector = MotionDetector()
        self._prev_frame = None

    def analyze_frame(self, frame: np.ndarray) -> FrameAnalysis:
        """Vollständige Analyse eines Frames."""
        faces = self.face_detector.detect_faces(frame)
        has_motion, _ = self.motion_detector.detect(frame)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        brightness = np.mean(gray) / 255.0

        if faces:
            primary_face = max(faces, key=lambda f: f.area)
            dominant_region = primary_face.center
        else:
            h, w = frame.shape[:2]
            dominant_region = (w // 2, h // 2)

        return FrameAnalysis(
            faces=faces,
            has_motion=has_motion,
            brightness=brightness,
            dominant_region=dominant_region
        )

    def get_zoom_target(self, frame: np.ndarray) -> tuple[float, float]:
        """
        Berechnet das Zoom-Ziel (0-1, 0-1) für einen Frame.

        Returns:
            (x, y) normalisiert auf 0-1
        """
        analysis = self.analyze_frame(frame)
        h, w = frame.shape[:2]

        if analysis.dominant_region:
            x, y = analysis.dominant_region
            return (x / w, y / h)

        return (0.5, 0.5)

    def analyze_video_for_smart_zoom(self, video_path: str,
                                      sample_interval: float = 0.5) -> List[Tuple[int, int, int]]:
        """
        Analysiert ein Video für Smart Zoom.

        Returns:
            Liste von (frame_index, center_x, center_y)
        """
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_interval = int(fps * sample_interval)

        results = []
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % frame_interval == 0:
                face = self.face_detector.get_primary_face(frame)
                if face:
                    results.append((frame_count, face.center[0], face.center[1]))

            frame_count += 1

        cap.release()
        return results

    def close(self):
        self.face_detector.close()


class SentimentAnalyzer:
    """
    Sentiment-Analyse für Text.
    Keyword-basiert für Geschwindigkeit und Offline-Nutzung.
    """

    EMOTION_KEYWORDS = {
        "happy": {
            "keywords": [
                "glücklich", "freude", "super", "toll", "geil", "nice", "cool",
                "happy", "great", "awesome", "amazing", "love", "liebe", "gut",
                "fantastisch", "wunderbar", "perfekt", "yeah", "yes", "ja", "wow",
                "haha", "lol", "schön", "beste", "best", "freut", "spaß", "fun"
            ],
            "emoji": "😊",
            "score": 0.8
        },
        "excited": {
            "keywords": [
                "krass", "wahnsinn", "unglaublich", "omg", "excited", "aufgeregt",
                "mega", "hammer", "boah", "alter", "damn", "holy", "incredible",
                "amazing", "mind", "blown", "crazy", "verrückt", "heftig", "wild"
            ],
            "emoji": "🤩",
            "score": 0.9
        },
        "sad": {
            "keywords": [
                "traurig", "sad", "leider", "schade", "schlecht", "mist", "shit",
                "unfortunately", "sorry", "tut mir leid", "verloren", "lost",
                "enttäuscht", "disappointed", "failed", "versagt", "weinen", "cry"
            ],
            "emoji": "😢",
            "score": -0.6
        },
        "angry": {
            "keywords": [
                "wütend", "angry", "ärger", "nervig", "annoying", "hate", "hass",
                "scheisse", "fuck", "damn", "verdammt", "kotzt", "nervt", "stupid"
            ],
            "emoji": "😤",
            "score": -0.8
        },
        "surprised": {
            "keywords": [
                "überrascht", "surprised", "what", "was", "hä", "echt", "really",
                "seriously", "ernsthaft", "no way", "niemals", "wow", "whoa",
                "plötzlich", "suddenly", "unerwartet", "unexpected"
            ],
            "emoji": "😮",
            "score": 0.3
        },
        "thinking": {
            "keywords": [
                "hmm", "vielleicht", "maybe", "perhaps", "denke", "think",
                "überlege", "wondering", "frage", "question", "wie", "how",
                "warum", "why", "interessant", "interesting"
            ],
            "emoji": "🤔",
            "score": 0.1
        },
        "laughing": {
            "keywords": [
                "haha", "hehe", "lol", "lmao", "rofl", "witzig", "funny",
                "lustig", "joke", "witz", "comedy", "laugh", "lachen"
            ],
            "emoji": "😂",
            "score": 0.7
        },
        "fire": {
            "keywords": [
                "fire", "hot", "lit", "sick", "dope", "fresh", "savage",
                "beast", "king", "queen", "goat", "legend", "epic"
            ],
            "emoji": "🔥",
            "score": 0.9
        },
        "heart": {
            "keywords": [
                "love", "liebe", "herz", "heart", "crush", "sweet", "süß",
                "cute", "adorable", "beautiful", "gorgeous", "lovely"
            ],
            "emoji": "❤️",
            "score": 0.8
        },
        "clap": {
            "keywords": [
                "bravo", "applaus", "clap", "congrats", "gratulation",
                "well done", "gut gemacht", "respect", "props"
            ],
            "emoji": "👏",
            "score": 0.7
        }
    }

    def analyze(self, text: str) -> Sentiment:
        """
        Analysiert den Sentiment eines Textes.

        Args:
            text: Der zu analysierende Text

        Returns:
            Sentiment Objekt mit Score, Emotion und Emoji
        """
        text_lower = text.lower()

        emotion_scores = {}

        for emotion, data in self.EMOTION_KEYWORDS.items():
            matches = sum(1 for kw in data["keywords"] if kw in text_lower)
            if matches > 0:
                emotion_scores[emotion] = {
                    "matches": matches,
                    "score": data["score"],
                    "emoji": data["emoji"]
                }

        if not emotion_scores:
            return Sentiment(score=0.0, emotion="neutral", emoji="😐")

        best_emotion = max(emotion_scores.keys(),
                          key=lambda e: emotion_scores[e]["matches"])

        return Sentiment(
            score=emotion_scores[best_emotion]["score"],
            emotion=best_emotion,
            emoji=emotion_scores[best_emotion]["emoji"]
        )

    def get_emoji_for_text(self, text: str) -> str:
        """Gibt das passende Emoji für einen Text zurück."""
        return self.analyze(text).emoji

    def get_emojis_for_subtitles(self, subtitles: list) -> list[tuple[float, str]]:
        """
        Analysiert Untertitel und gibt Emojis mit Zeitpunkten zurück.

        Args:
            subtitles: Liste von Subtitle-Objekten

        Returns:
            Liste von (timestamp, emoji) Tuples
        """
        results = []

        for sub in subtitles:
            sentiment = self.analyze(sub.text)
            if sentiment.emotion != "neutral":
                timestamp = (sub.start + sub.end) / 2
                results.append((timestamp, sentiment.emoji))

        return results


class SceneDetector:
    """Erkennt Szenenwechsel im Video."""

    def __init__(self, threshold: float = 30.0):
        self.threshold = threshold
        self._prev_hist = None

    def is_scene_change(self, frame: np.ndarray) -> bool:
        """
        Prüft ob ein Szenenwechsel stattgefunden hat.

        Args:
            frame: Aktueller Frame

        Returns:
            True wenn Szenenwechsel erkannt
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
        hist = cv2.normalize(hist, hist).flatten()

        if self._prev_hist is None:
            self._prev_hist = hist
            return False

        diff = cv2.compareHist(self._prev_hist, hist, cv2.HISTCMP_CHISQR)

        self._prev_hist = hist
        return diff > self.threshold

    def detect_scenes(self, video_path: str, sample_rate: int = 5) -> list[float]:
        """
        Findet alle Szenenwechsel in einem Video.

        Args:
            video_path: Pfad zum Video
            sample_rate: Jeden n-ten Frame analysieren

        Returns:
            Liste von Zeitpunkten (in Sekunden) der Szenenwechsel
        """
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        scene_changes = []
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % sample_rate == 0:
                if self.is_scene_change(frame):
                    timestamp = frame_count / fps
                    scene_changes.append(timestamp)

            frame_count += 1

        cap.release()
        return scene_changes

    def reset(self):
        """Setzt den Detektor zurück."""
        self._prev_hist = None


class ContentAnalyzer:
    """
    Kombinierte Content-Analyse für Videos.
    Fasst alle Analyse-Komponenten zusammen.
    """

    def __init__(self):
        self.face_detector = FaceDetector()
        self.motion_detector = MotionDetector()
        self.scene_detector = SceneDetector()
        self.sentiment_analyzer = SentimentAnalyzer()
        self.object_tracker = ObjectTracker()

    def analyze_video(self, video_path: str, subtitles: list = None) -> dict:
        """
        Vollständige Analyse eines Videos.

        Args:
            video_path: Pfad zum Video
            subtitles: Optional, Liste von Untertiteln

        Returns:
            Dict mit allen Analyse-Ergebnissen
        """
        results = {
            'faces': [],
            'scenes': [],
            'motion_regions': [],
            'emojis': [],
            'highlights': []
        }

        # Szenen-Erkennung
        results['scenes'] = self.scene_detector.detect_scenes(video_path)

        # Gesichts-Tracking
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % int(fps * 0.5) == 0:  # Alle 0.5 Sekunden
                timestamp = frame_count / fps

                # Gesichter
                face = self.face_detector.get_primary_face(frame)
                if face:
                    results['faces'].append({
                        'time': timestamp,
                        'center': face.center,
                        'size': (face.width, face.height)
                    })

                # Bewegung
                has_motion, mask = self.motion_detector.detect(frame)
                if has_motion:
                    regions = self.motion_detector.get_motion_regions(frame)
                    if regions:
                        results['motion_regions'].append({
                            'time': timestamp,
                            'regions': regions
                        })

            frame_count += 1

        cap.release()

        # Emoji-Events aus Untertiteln
        if subtitles:
            results['emojis'] = self.sentiment_analyzer.get_emojis_for_subtitles(subtitles)

        return results

    def close(self):
        """Räumt Ressourcen auf."""
        self.face_detector.close()
        self.motion_detector.reset()
        self.scene_detector.reset()
        self.object_tracker.reset()


@dataclass
class ActionEvent:
    """Ein erkanntes Action-Event im Video."""
    timestamp: float        # Zeitpunkt des Events
    action: str             # "falling", "jumping", "movement_start", "stillstand", etc.
    confidence: float       # Konfidenz der Erkennung (0-1)
    duration: float         # Geschätzte Dauer der Aktion


class ActionDetector:
    """
    Erkennt Aktionen im Video basierend auf Bewegungsanalyse.

    Unterstützte Aktionen:
    - falling: Schnelle Abwärtsbewegung + Stillstand
    - jumping: Schnelle Aufwärtsbewegung
    - movement_start: Beginn von Bewegung nach Ruhe
    - stillstand: Ruhe nach Bewegung
    - standing_up: Aufwärtsbewegung (Aufstehen)
    - sitting_down: Abwärtsbewegung + Stillstand (Hinsetzen)
    """

    def __init__(self, use_pose: bool = False):
        """
        Args:
            use_pose: Ob MediaPipe Pose verwendet werden soll (optional)
        """
        self.motion_detector = MotionDetector(threshold=20.0)
        self.use_pose = use_pose
        self.pose = None

        if use_pose:
            try:
                import mediapipe as mp
                self.pose = mp.solutions.pose.Pose(
                    static_image_mode=False,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5
                )
                print("    ActionDetector: MediaPipe Pose aktiviert")
            except ImportError:
                self.use_pose = False
                print("    ActionDetector: MediaPipe nicht verfügbar, nutze Motion-Analyse")

    def detect_events(self, video_path: str, sample_rate: float = 0.1) -> List[ActionEvent]:
        """
        Findet alle Action-Events im Video.

        Args:
            video_path: Pfad zum Video
            sample_rate: Abtastrate in Sekunden

        Returns:
            Liste von ActionEvent Objekten
        """
        events = []
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_interval = max(1, int(fps * sample_rate))

        # Motion-Historie für Analyse
        motion_history = []  # (timestamp, motion_amount, motion_direction)
        prev_center_y = None
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % frame_interval == 0:
                timestamp = frame_count / fps

                # Motion-Analyse
                has_motion, mask = self.motion_detector.detect(frame)

                motion_amount = 0.0
                motion_direction = 0  # -1 = up, 0 = neutral, 1 = down

                if has_motion and mask is not None:
                    # Berechne Bewegungsmenge
                    motion_amount = np.sum(mask > 0) / mask.size

                    # Berechne Bewegungsrichtung (Zentroid)
                    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if contours:
                        # Größter Contour
                        largest = max(contours, key=cv2.contourArea)
                        M = cv2.moments(largest)
                        if M["m00"] > 0:
                            center_y = int(M["m01"] / M["m00"])
                            if prev_center_y is not None:
                                dy = center_y - prev_center_y
                                if abs(dy) > 10:
                                    motion_direction = 1 if dy > 0 else -1
                            prev_center_y = center_y

                motion_history.append((timestamp, motion_amount, motion_direction))

            frame_count += 1

        cap.release()
        self.motion_detector.reset()

        # Analysiere Motion-Historie für Events
        events = self._analyze_motion_history(motion_history)

        return events

    def _analyze_motion_history(self, history: List[Tuple[float, float, int]]) -> List[ActionEvent]:
        """Analysiert Motion-Historie und erkennt Events."""
        events = []

        if len(history) < 10:
            return events

        # Sliding Window für Pattern-Erkennung
        window_size = 10

        for i in range(window_size, len(history)):
            window = history[i-window_size:i]
            current = history[i]

            timestamps = [h[0] for h in window]
            motions = [h[1] for h in window]
            directions = [h[2] for h in window]

            avg_motion = np.mean(motions)
            recent_motion = np.mean(motions[-3:])
            older_motion = np.mean(motions[:3])

            # Falling Detection: Hohe Bewegung + Abwärts + dann Ruhe
            if (avg_motion > 0.02 and
                sum(d == 1 for d in directions) > window_size * 0.6 and
                recent_motion < older_motion * 0.5):
                events.append(ActionEvent(
                    timestamp=current[0] - 0.5,  # Kurz vor dem Stillstand
                    action="falling",
                    confidence=min(avg_motion * 10, 1.0),
                    duration=1.0
                ))

            # Jumping Detection: Hohe Bewegung + Aufwärts
            if (avg_motion > 0.03 and
                sum(d == -1 for d in directions) > window_size * 0.5):
                events.append(ActionEvent(
                    timestamp=current[0] - 0.3,
                    action="jumping",
                    confidence=min(avg_motion * 10, 1.0),
                    duration=0.5
                ))

            # Movement Start: Von Ruhe zu Bewegung
            if (older_motion < 0.005 and recent_motion > 0.02):
                events.append(ActionEvent(
                    timestamp=current[0],
                    action="movement_start",
                    confidence=min(recent_motion * 20, 1.0),
                    duration=0.5
                ))

            # Stillstand: Von Bewegung zu Ruhe
            if (older_motion > 0.02 and recent_motion < 0.005):
                events.append(ActionEvent(
                    timestamp=current[0],
                    action="stillstand",
                    confidence=min(older_motion * 20, 1.0),
                    duration=1.0
                ))

        # Dedupliziere Events (entferne zu nahe beieinander liegende)
        events = self._deduplicate_events(events, min_gap=1.0)

        return events

    def _deduplicate_events(self, events: List[ActionEvent], min_gap: float = 1.0) -> List[ActionEvent]:
        """Entfernt doppelte Events die zu nah beieinander liegen."""
        if not events:
            return events

        # Sortiere nach Zeitstempel
        sorted_events = sorted(events, key=lambda e: e.timestamp)

        # Gruppiere nach Action-Typ
        by_action = {}
        for event in sorted_events:
            if event.action not in by_action:
                by_action[event.action] = []
            by_action[event.action].append(event)

        # Dedupliziere pro Action-Typ
        result = []
        for action, action_events in by_action.items():
            last_time = -float('inf')
            for event in action_events:
                if event.timestamp - last_time >= min_gap:
                    result.append(event)
                    last_time = event.timestamp

        return sorted(result, key=lambda e: e.timestamp)

    def detect_falling(self, video_path: str) -> List[float]:
        """
        Erkennt Momente wo jemand hinfällt.

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_events(video_path)
        return [e.timestamp for e in events if e.action == "falling"]

    def detect_jumping(self, video_path: str) -> List[float]:
        """
        Erkennt Momente wo jemand springt.

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_events(video_path)
        return [e.timestamp for e in events if e.action == "jumping"]

    def detect_movement_start(self, video_path: str) -> List[float]:
        """
        Erkennt Beginn von Bewegungen.

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_events(video_path)
        return [e.timestamp for e in events if e.action == "movement_start"]

    def detect_stillstand(self, video_path: str) -> List[float]:
        """
        Erkennt Momente der Ruhe nach Bewegung.

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_events(video_path)
        return [e.timestamp for e in events if e.action == "stillstand"]

    def get_action_times(self, video_path: str, action: str) -> List[float]:
        """
        Gibt Zeitpunkte für eine bestimmte Action zurück.

        Args:
            video_path: Pfad zum Video
            action: "falling", "jumping", "movement_start", "stillstand"

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_events(video_path)
        return [e.timestamp for e in events if e.action == action]

    def close(self):
        """Räumt Ressourcen auf."""
        self.motion_detector.reset()
        if self.pose:
            self.pose.close()


@dataclass
class ObjectEvent:
    """Ein erkanntes Objekt-Event im Video."""
    timestamp: float        # Zeitpunkt des Events
    object_name: str        # "laptop", "phone", "person", etc.
    confidence: float       # Konfidenz der Erkennung (0-1)
    duration: float         # Wie lange das Objekt sichtbar ist
    bbox: Optional[Tuple[int, int, int, int]] = None  # Bounding Box (x, y, w, h)


class ObjectDetector:
    """
    Erkennt Objekte im Video mit YOLO.

    Unterstützte Objekte (COCO Dataset):
    - person, laptop, cell phone, tv, keyboard, mouse
    - cup, bottle, book, clock, scissors
    - car, bicycle, motorcycle, bus, truck
    - cat, dog, bird, etc.
    """

    # COCO Klassen-Namen (80 Klassen)
    COCO_CLASSES = [
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
        "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
        "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
        "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
        "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
        "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
        "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
        "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
        "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
        "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
        "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
        "toothbrush"
    ]

    # Deutsche Übersetzungen für Keywords (alle 80 COCO Klassen)
    OBJECT_TRANSLATIONS = {
        # === PERSONEN ===
        "person": "person", "mensch": "person", "leute": "person",
        "ich": "person", "gesicht": "person", "körper": "person",

        # === FAHRZEUGE ===
        "fahrrad": "bicycle", "bicycle": "bicycle", "rad": "bicycle", "bike": "bicycle",
        "auto": "car", "car": "car", "wagen": "car", "pkw": "car",
        "motorrad": "motorcycle", "motorcycle": "motorcycle", "moped": "motorcycle", "roller": "motorcycle",
        "flugzeug": "airplane", "airplane": "airplane", "flieger": "airplane",
        "bus": "bus", "reisebus": "bus",
        "zug": "train", "train": "train", "bahn": "train",
        "lkw": "truck", "truck": "truck", "lastwagen": "truck",
        "boot": "boat", "boat": "boat", "schiff": "boat",

        # === STRASSENOBJEKTE ===
        "ampel": "traffic light", "traffic light": "traffic light",
        "hydrant": "fire hydrant", "fire hydrant": "fire hydrant",
        "stoppschild": "stop sign", "stop sign": "stop sign",
        "parkuhr": "parking meter", "parking meter": "parking meter",
        "bank": "bench", "bench": "bench", "parkbank": "bench", "sitzbank": "bench",

        # === TIERE ===
        "vogel": "bird", "bird": "bird",
        "katze": "cat", "cat": "cat", "mieze": "cat",
        "hund": "dog", "dog": "dog",
        "pferd": "horse", "horse": "horse",
        "schaf": "sheep", "sheep": "sheep",
        "kuh": "cow", "cow": "cow", "rind": "cow",
        "elefant": "elephant", "elephant": "elephant",
        "bär": "bear", "bear": "bear",
        "zebra": "zebra", "giraffe": "giraffe",

        # === ACCESSOIRES ===
        "rucksack": "backpack", "backpack": "backpack", "tasche": "backpack",
        "regenschirm": "umbrella", "umbrella": "umbrella", "schirm": "umbrella",
        "handtasche": "handbag", "handbag": "handbag",
        "krawatte": "tie", "tie": "tie", "schlips": "tie",
        "koffer": "suitcase", "suitcase": "suitcase", "trolley": "suitcase",

        # === SPORT ===
        "frisbee": "frisbee",
        "ski": "skis", "skis": "skis",
        "snowboard": "snowboard",
        "ball": "sports ball", "sports ball": "sports ball",
        "fußball": "sports ball", "basketball": "sports ball", "tennis": "sports ball",
        "drachen": "kite", "kite": "kite",
        "baseballschläger": "baseball bat", "baseball bat": "baseball bat",
        "baseballhandschuh": "baseball glove", "baseball glove": "baseball glove",
        "skateboard": "skateboard",
        "surfbrett": "surfboard", "surfboard": "surfboard",
        "tennisschläger": "tennis racket", "tennis racket": "tennis racket",

        # === KÜCHE / ESSEN ===
        "flasche": "bottle", "bottle": "bottle",
        "weinglas": "wine glass", "wine glass": "wine glass", "glas": "wine glass",
        "tasse": "cup", "cup": "cup", "becher": "cup", "kaffee": "cup",
        "gabel": "fork", "fork": "fork",
        "messer": "knife", "knife": "knife",
        "löffel": "spoon", "spoon": "spoon",
        "schüssel": "bowl", "bowl": "bowl", "schale": "bowl",
        "banane": "banana", "banana": "banana",
        "apfel": "apple", "apple": "apple",
        "sandwich": "sandwich", "brot": "sandwich",
        "orange": "orange",
        "brokkoli": "broccoli", "broccoli": "broccoli",
        "karotte": "carrot", "carrot": "carrot", "möhre": "carrot",
        "hotdog": "hot dog", "hot dog": "hot dog",
        "pizza": "pizza",
        "donut": "donut",
        "kuchen": "cake", "cake": "cake", "torte": "cake",

        # === MÖBEL ===
        "stuhl": "chair", "chair": "chair",
        "sofa": "couch", "couch": "couch", "sessel": "couch",
        "pflanze": "potted plant", "potted plant": "potted plant",
        "blume": "potted plant", "zimmerpflanze": "potted plant",
        "bett": "bed", "bed": "bed",
        "tisch": "dining table", "dining table": "dining table",
        "esstisch": "dining table", "schreibtisch": "dining table",
        "toilette": "toilet", "toilet": "toilet", "klo": "toilet", "wc": "toilet",

        # === ELEKTRONIK ===
        "fernseher": "tv", "tv": "tv", "monitor": "tv",
        "bildschirm": "tv", "television": "tv",
        "laptop": "laptop", "notebook": "laptop", "computer": "laptop", "macbook": "laptop",
        "maus": "mouse", "mouse": "mouse", "computermaus": "mouse",
        "fernbedienung": "remote", "remote": "remote",
        "tastatur": "keyboard", "keyboard": "keyboard",
        "handy": "cell phone", "telefon": "cell phone", "smartphone": "cell phone",
        "phone": "cell phone", "cell phone": "cell phone",
        "iphone": "cell phone", "android": "cell phone",

        # === HAUSHALTSGERÄTE ===
        "mikrowelle": "microwave", "microwave": "microwave",
        "ofen": "oven", "oven": "oven", "backofen": "oven", "herd": "oven",
        "toaster": "toaster",
        "spüle": "sink", "sink": "sink", "waschbecken": "sink",
        "kühlschrank": "refrigerator", "refrigerator": "refrigerator",

        # === SONSTIGES ===
        "buch": "book", "book": "book", "bücher": "book",
        "uhr": "clock", "clock": "clock", "wanduhr": "clock", "wecker": "clock",
        "vase": "vase", "blumenvase": "vase",
        "schere": "scissors", "scissors": "scissors",
        "teddybär": "teddy bear", "teddy bear": "teddy bear",
        "teddy": "teddy bear", "kuscheltier": "teddy bear", "plüschtier": "teddy bear",
        "fön": "hair drier", "hair drier": "hair drier", "haartrockner": "hair drier",
        "zahnbürste": "toothbrush", "toothbrush": "toothbrush",
    }

    def __init__(self, confidence_threshold: float = 0.5):
        """
        Args:
            confidence_threshold: Mindest-Konfidenz für Erkennung (0-1)
        """
        self.confidence_threshold = confidence_threshold
        self.model = None
        self._yolo_available = False

        # Versuche YOLO zu laden
        try:
            from ultralytics import YOLO
            # Nutze YOLOv8 nano (schnell und klein)
            # Im Nuitka Bundle liegt das Modell neben der Binary
            if getattr(sys, 'frozen', False) or '__compiled__' in globals():
                yolo_path = str(Path(sys.executable).parent / 'yolov8n.pt')
            else:
                yolo_path = str(Path(__file__).parent.parent / 'yolov8n.pt')
            if not os.path.isfile(yolo_path):
                yolo_path = 'yolov8n.pt'
            self.model = YOLO(yolo_path)
            self._yolo_available = True
            print("    ObjectDetector: YOLO geladen")
        except ImportError:
            print("    ObjectDetector: ultralytics nicht installiert")
            print("    Installiere mit: pip install ultralytics")
        except Exception as e:
            print(f"    ObjectDetector: YOLO Fehler: {e}")

    def is_available(self) -> bool:
        """Prüft ob Objekterkennung verfügbar ist."""
        return self._yolo_available and self.model is not None

    def translate_object_name(self, german_name: str) -> str:
        """Übersetzt deutschen Objektnamen zu COCO Klassennamen."""
        return self.OBJECT_TRANSLATIONS.get(german_name.lower(), german_name.lower())

    def detect_objects_in_frame(self, frame: np.ndarray) -> List[Tuple[str, float, Tuple[int, int, int, int]]]:
        """
        Erkennt Objekte in einem einzelnen Frame.

        Args:
            frame: BGR numpy array

        Returns:
            Liste von (object_name, confidence, bbox) Tuples
        """
        if not self.is_available():
            return []

        try:
            results = self.model(frame, verbose=False)

            detections = []
            for result in results:
                boxes = result.boxes
                if boxes is None:
                    continue

                for box in boxes:
                    conf = float(box.conf[0])
                    if conf < self.confidence_threshold:
                        continue

                    cls_id = int(box.cls[0])
                    if cls_id < len(self.COCO_CLASSES):
                        obj_name = self.COCO_CLASSES[cls_id]
                        x1, y1, x2, y2 = map(int, box.xyxy[0])
                        bbox = (x1, y1, x2 - x1, y2 - y1)
                        detections.append((obj_name, conf, bbox))

            return detections

        except Exception as e:
            print(f"    Objekterkennung Fehler: {e}")
            return []

    def detect_object_appearances(self, video_path: str, target_object: str,
                                   sample_rate: float = 0.1) -> List[ObjectEvent]:
        """
        Findet alle Erscheinungen eines Objekts im Video.

        Args:
            video_path: Pfad zum Video
            target_object: Gesuchtes Objekt (deutsch oder englisch)
            sample_rate: Abtastrate in Sekunden

        Returns:
            Liste von ObjectEvent Objekten
        """
        if not self.is_available():
            print("    WARNUNG: Objekterkennung nicht verfügbar")
            return []

        # Übersetze Objektname
        target_coco = self.translate_object_name(target_object)
        print(f"    Suche nach: {target_object} -> {target_coco}")

        events = []
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_interval = max(1, int(fps * sample_rate))

        object_visible = False
        appearance_start = 0.0
        last_confidence = 0.0
        last_bbox = None
        frame_count = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count % frame_interval == 0:
                timestamp = frame_count / fps
                detections = self.detect_objects_in_frame(frame)

                # Prüfe ob Zielobjekt erkannt wurde
                found = False
                for obj_name, conf, bbox in detections:
                    if obj_name == target_coco:
                        found = True
                        last_confidence = conf
                        last_bbox = bbox
                        break

                if found and not object_visible:
                    # Objekt erscheint
                    object_visible = True
                    appearance_start = timestamp
                elif not found and object_visible:
                    # Objekt verschwindet
                    object_visible = False
                    duration = timestamp - appearance_start
                    if duration > 0.3:  # Mindestdauer
                        events.append(ObjectEvent(
                            timestamp=appearance_start,
                            object_name=target_coco,
                            confidence=last_confidence,
                            duration=duration,
                            bbox=last_bbox
                        ))

            frame_count += 1

        # Falls Objekt am Ende noch sichtbar
        if object_visible:
            duration = (frame_count / fps) - appearance_start
            if duration > 0.3:
                events.append(ObjectEvent(
                    timestamp=appearance_start,
                    object_name=target_coco,
                    confidence=last_confidence,
                    duration=duration,
                    bbox=last_bbox
                ))

        cap.release()

        print(f"    {len(events)} '{target_object}' Erscheinungen gefunden")
        return events

    def get_object_times(self, video_path: str, object_name: str) -> List[float]:
        """
        Gibt Zeitpunkte zurück, an denen ein Objekt erscheint.

        Args:
            video_path: Pfad zum Video
            object_name: Gesuchtes Objekt

        Returns:
            Liste von Zeitstempeln
        """
        events = self.detect_object_appearances(video_path, object_name)
        return [e.timestamp for e in events]

    def close(self):
        """Räumt Ressourcen auf."""
        self.model = None
