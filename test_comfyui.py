import requests

def test_comfyui_connection(url="http://127.0.0.1:8189"):
    try:
        response = requests.get(url, timeout=10)
        
        if response.status_code == 200:
            print(f"✅ ComfyUI 服务运行正常 (状态码: {response.status_code})")
            return True
        else:
            print(f"❌ ComfyUI 服务返回异常状态码: {response.status_code}")
            return False
            
    except requests.exceptions.ConnectionError:
        print("❌ 无法连接到 ComfyUI 服务 - 连接被拒绝")
        return False
    except requests.exceptions.Timeout:
        print("❌ 连接 ComfyUI 服务超时")
        return False
    except Exception as e:
        print(f"❌ 连接时发生错误: {str(e)}")
        return False

# 测试连接
test_comfyui_connection()