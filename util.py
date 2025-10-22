import glob 
import os 
import requests
import pandas as pd
import json
import urllib.request
import urllib.parse
import pandas as pd
import urllib.request
import urllib.parse
import time
import uuid


SDXL_SUPPORTED_RESOLUTIONS = [
    (1024, 1024, 1.0),
    (1152, 896, 1.2857142857142858),
    (896, 1152, 0.7777777777777778),
    (1216, 832, 1.4615384615384615),
    (832, 1216, 0.6842105263157895),
    (1344, 768, 1.75),
    (768, 1344, 0.5714285714285714),
    (1536, 640, 2.4),
    (640, 1536, 0.4166666666666667),
]



##-----------------------------------------ComfyUI example-----------------------------------------##
def queue_prompt(prompt):
    p = {"prompt": prompt, "client_id": client_id}
    data = json.dumps(p).encode('utf-8')
    req =  urllib.request.Request("http://{}/prompt".format(server_address), data=data)
    return json.loads(urllib.request.urlopen(req).read())

def get_image(filename, subfolder, folder_type):
    data = {"filename": filename, "subfolder": subfolder, "type": folder_type}
    url_values = urllib.parse.urlencode(data)
    with urllib.request.urlopen("http://{}/view?{}".format(server_address, url_values)) as response:
        return response.read()

def get_history(prompt_id):
    with urllib.request.urlopen("http://{}/history/{}".format(server_address, prompt_id)) as response:
        return json.loads(response.read())

def get_images(ws, prompt):
    prompt_id = queue_prompt(prompt)['prompt_id']
    output_images = {}
    while True:
        out = ws.recv()
        if isinstance(out, str):
            message = json.loads(out)
            if message['type'] == 'executing':
                data = message['data']
                if data['node'] is None and data['prompt_id'] == prompt_id:
                    break #Execution is done
        else:
            continue #previews are binary data

    history = get_history(prompt_id)[prompt_id]
    for o in history['outputs']:
        for node_id in history['outputs']:
            node_output = history['outputs'][node_id]
            if 'images' in node_output:
                images_output = []
                for image in node_output['images']:
                    image_data = get_image(image['filename'], image['subfolder'], image['type'])
                    images_output.append(image_data)
            output_images[node_id] = images_output

    return output_images
##-----------------------------------------ComfyUI example-----------------------------------------##
def get_images_from_disk(folder_path):
    # check dir exists
    image_extensions = ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff','.webp')  # 支持的图片格式
    if not os.path.isdir(folder_path):
        print(f"Directory does not exist: {folder_path}")
        return []
    # Patterns for JPG and PNG 
    all_pattern=[]
    for ext in image_extensions:
        all_pattern.append(os.path.join(folder_path, f'*{ext}'))
    # Use glob to search for JPG and PNG files in the directory
    # images_list = glob.glob(jpg_pattern, recursive=True) + glob.glob(png_pattern, recursive=True)+ glob.glob(jpeg_pattern, recursive=True)
    images_list=[]
    for one_pattern in all_pattern:
        paths=glob.glob(one_pattern, recursive=True)
        if paths:
            images_list.extend(paths) 
    return images_list

def get_images_from_disk_all(directory):
    """
    递归获取目录下所有图片文件的路径
    """
    image_extensions = ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff','.webp')  # 支持的图片格式
    image_paths = []

    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(image_extensions):
                image_paths.append(os.path.join(root, file))  # 拼接完整路径

    return image_paths


def upload_img_post(server_address,input_img_paths):
    for file_path in input_img_paths:
        # 创建文件对象
        files = {'image': open(file_path, 'rb')}

        # 上传图像
        response = requests.post(f"{server_address}/upload/image", files=files)

        # 检查响应
        if response.status_code == 200:
            data = response.json()
            print("Upload successful! at path:", data.get("name"))
        else:
            print("Failed to upload image.")
            print("Status code:", response.status_code)
            print("Response:", response.text)

# 遍历 JSON 数据，找到具有指定 title 的节点
def json_by_title(data, title):
    for key, node in data.items():
        if node.get("_meta", {}).get("title") == title:
            if "inputs" in node and "image" in node["inputs"]:
                return key
    print(f"No node found with title {title}")    
    return None

def get_from_excel(file_path ='HeadShot_paramdata.xlsx'):
    df = pd.read_excel(file_path)
    # Loop through each row to extract the required information
    extracted_data = []
    for index, row in df.iterrows():
        line_number = row['Number']
        prompt = row['Prompt']
        negative_prompt = row['Negative Prompt']
        gender=row['Gender']
        # Splitting the 'PuLID' field to get method and weight
        method = row['Pulid Method']
        weight = row['Pulid Weight']
        
        extracted_data.append({
            'Number': line_number,
            'Prompt': prompt,
            'Negative Prompt': negative_prompt,
            'Method': method,
            'Weight': weight,
            "Gender":gender
        })
    return extracted_data

def get_from_excel_backend(file_path ='headshot_style_release.xlsx'):
    df = pd.read_excel(file_path)
    # Loop through each row to extract the required information
    extracted_data = []
    for index, row in df.iterrows():
        line_number = row['id']
        prompt = row['prompt']
        negative_prompt = row['negative_prompt']
        gender=row['gender']
        # Splitting the 'PuLID' field to get method and weight
        method = row['pulid_method']
        weight = row['pulid_weight']
        
        extracted_data.append({
            'Number': line_number,
            'Prompt': prompt,
            'Negative Prompt': negative_prompt,
            'Method': method,
            'Weight': weight,
            "Gender":gender
        })
    return extracted_data

def get_data_from_excel(file_path = 'run_headshot.xlsx'):
    df = pd.read_excel(file_path)
    # Loop through each row to extract the required information
    extracted_data = []
    for index, row in df.iterrows():
        line_number = index + 1
        prompt = row['prompt']
        negative_prompt = row['negative prompt']
        gender=row['gender']
        # Splitting the 'PuLID' field to get method and weight
        pulid_split = row['PuLID'].split()
        # print(str(line_number)+": "+ row['PuLID'])
        method = pulid_split[0].split(':')[1]
        weight = pulid_split[1].split(':')[1]
        
        extracted_data.append({
            'Number': line_number,
            'Prompt': prompt,
            'Negative Prompt': negative_prompt,
            'Method': method,
            'Weight': weight,
            "Gender":gender
        })
    return extracted_data
    # Convert the extracted data into a DataFrame for better visualization
    extracted_df = pd.DataFrame(extracted_data)

    # Display the extracted data
    # print(extracted_df)

    # # Optionally, save the extracted data to a new Excel file
    # extracted_df.to_excel('extracted_data.xlsx', index=False)
    
    


class APIClient:
    def __init__(self, server_address,verbose=False):
        self.server_address = server_address
        self.client_id = str(uuid.uuid4())
        self.verbose = verbose

    def queue_prompt(self, prompt):
        p = {"prompt": prompt, "client_id": self.client_id}
        data = json.dumps(p).encode('utf-8')
        req = urllib.request.Request(f"http://{self.server_address}/prompt", data=data)
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read())

    def get_image(self, filename, subfolder, folder_type):
        data = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        url_values = urllib.parse.urlencode(data)
        with urllib.request.urlopen(f"http://{self.server_address}/view?{url_values}") as response:
            return response.read()

    def get_history(self, prompt_id):
        with urllib.request.urlopen(f"http://{self.server_address}/history/{prompt_id}") as response:
            return json.loads(response.read())

    def get_images(self, ws, prompt):
        prompt_id = self.queue_prompt(prompt)['prompt_id']
        output_images = {}
        start_time = time.perf_counter()

        while True:
            out = ws.recv()
            if isinstance(out, str):
                message = json.loads(out)
                if message['type'] == 'executing':
                    data = message['data']
                    if data['node'] is None and data['prompt_id'] == prompt_id:
                        break  # Execution is done
            else:
                time.sleep(0.1)  # 每次接收后等待0.1秒，避免请求过于频繁
                continue  # previews are binary data
        if self.verbose:
            print("T1", time.perf_counter() - start_time)

        start_time = time.perf_counter()
        history = self.get_history(prompt_id)[prompt_id]
        if self.verbose:
            print("T2.1", time.perf_counter() - start_time)

        start_time = time.perf_counter()
        for node_id in history['outputs']:
            node_output = history['outputs'][node_id]
            images_output = []
            if 'images' in node_output:
                for image in node_output['images']:
                    image_data = self.get_image(image['filename'], image['subfolder'], image['type'])
                    images_output.append(image_data)
            output_images[node_id] = images_output
        if self.verbose:
            print("T2.2", time.perf_counter() - start_time)

        return output_images
