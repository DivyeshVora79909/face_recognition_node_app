import os
from pathlib import Path
import pandas as pd
from datetime import datetime

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_USE_LEGACY_KERAS"] = "1"
os.environ["KERAS_BACKEND"] = "tensorflow"

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from deepface.modules import recognition
import cv2
import numpy as np
import base64
import traceback
from dotenv import load_dotenv
import json

with open("timetable.json", "r") as file:
    timetable = json.load(file)

load_dotenv()

app = FastAPI()
# Configuration
MEDIA = os.getenv("MEDIA")
MEDIA_DIR = Path(MEDIA)
ATTENDANCE_DIR = MEDIA_DIR / "attendance"
IMAGE_DIR = MEDIA_DIR / "images"
CSV_STORE = Path(os.getenv("CSV_STORE"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", 5))  # Default to 5 if not set

# Ensure directories exist
ATTENDANCE_DIR.mkdir(parents=True, exist_ok=True)
CSV_STORE.mkdir(parents=True, exist_ok=True)


from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, date
import asyncio

# MongoDB connection
mongo_client = AsyncIOMotorClient(os.getenv("MONGO_URI"))
db = mongo_client.institution
users_collection = db.users


def extract_identifier(file_path):
    # Split the file path to get the file name
    file_name = os.path.basename(file_path)

    # Split the file name by underscores to get the identifier
    if "_" in file_name:
        identifier = file_name.split("_")[0]
    else:
        # If no underscore is found, remove the file extension
        identifier = os.path.splitext(file_name)[0]

    return identifier


# Global results storage
global_results = []

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def base64_to_numpy(image_b64: str) -> np.ndarray:
    image_bytes = base64.b64decode(image_b64)
    np_arr = np.frombuffer(image_bytes, np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)


def get_subject_from_timestamp(timestamp):
    day = timestamp.strftime("%A")
    time = timestamp.time()
    day_schedule = timetable.get(day, {})
    for time_slot, subject in day_schedule.items():
        start_str, end_str = time_slot.split("-")
        start = datetime.strptime(start_str, "%H:%M").time()
        end = datetime.strptime(end_str, "%H:%M").time()
        if start <= time < end:
            return subject
    return "Unknown"
    return None


def save_results_to_csv():
    global global_results
    if not global_results:
        return

    try:
        current_date = datetime.now().strftime("%Y%m%d")
        filename = f"DT{current_date}.csv"
        csv_path = CSV_STORE / filename

        # Convert to DataFrame
        df = pd.DataFrame(global_results)
        # if not df.empty:
        #     df["subject"] = df["timestamp"].apply(get_subject_from_timestamp)

        # Save to CSV
        header = not csv_path.exists()
        df.to_csv(csv_path, mode="a", index=False, header=False)

        # Clear results after successful save
        global_results = []
    except Exception as e:
        traceback.print_exc()
        # Keep results to retry later


async def store_attendance_result(result):
    try:
        current_date = date.today().isoformat()
        # print(result["matched"])
        uid = extract_identifier(result["matched"])
        # print(uid)

        await users_collection.update_one(
            {"uid": uid}, {"$push": {f"attendance.{current_date}": result}}, upsert=True
        )
    except Exception as e:
        print(f"MongoDB write error for uid {uid}: {e}")
        traceback.print_exc()


@app.post("/attendance")
async def analyze_image(data: dict):
    try:
        image_b64 = data["image"].split(",")[-1]
        image_np = base64_to_numpy(image_b64)
        # 2025-02-18T10:10:25.994+00:00
        try:
            result = recognition.find6(
                img_path=image_np[:, :, ::-1],
                db_path=IMAGE_DIR,
                img_store_path=ATTENDANCE_DIR,
                model_name="ArcFace",
                enforce_detection=False,
                detector_backend="retinaface",
                normalization="ArcFace",
                align=True,
            )
            print(result)
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Recognition error: {str(e)}")

        # Store results
        current_time = datetime.now()
        store_tasks = []
        for item in result:
            # if item.get("matched") is not None:
            item["Subject"] = get_subject_from_timestamp(current_time)
            item["timestamp"] = current_time
            store_tasks.append(store_attendance_result(item))

        # Run all storage operations concurrently
        await asyncio.gather(*store_tasks)

        height, width, channels = image_np.shape
        return {
            "recognition_result": result,
            "dimensions": f"{width}x{height}x{channels}",
            "dtype": str(image_np.dtype),
        }
    except Exception as e:
        traceback.print_exc()
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=400, detail=f"Processing error: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
