#!/data/data/com.termux/files/usr/bin/bash
# Android Node 自动安装脚本（在 Termux 中运行）

echo "🚀 Android Node 安装脚本"
echo "========================"

# 更新包管理器
echo "📦 更新包管理器..."
pkg update -y

# 安装 Python 和依赖
echo "🐍 安装 Python..."
pkg install -y python python-pip

# 安装 Python 依赖
echo "📚 安装 Python 依赖..."
pip install --upgrade pip
pip install uiautomator2 websockets aiohttp pillow pytesseract

# 创建工作目录
echo "📁 创建工作目录..."
mkdir -p ~/android-node
cd ~/android-node

# 复制文件（假设已通过 adb push 或其他方式传输）
# 如果文件在 /sdcard/android-node/
if [ -d "/sdcard/android-node" ]; then
    echo "📋 复制文件..."
    cp -r /sdcard/android-node/* ~/android-node/
fi

# 创建启动脚本
echo "📝 创建启动脚本..."
cat > ~/android-node/start.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd ~/android-node
python server.py
EOF

chmod +x ~/android-node/start.sh

# 初始化 uiautomator2
echo "🔧 初始化 uiautomator2..."
python -m uiautomator2 init

# 创建开机自启脚本（如果安装了 Termux:Boot）
if pkg list-installed | grep -q termux-boot; then
    echo "🔄 配置开机自启..."
    mkdir -p ~/.termux/boot
    cp ~/android-node/start.sh ~/.termux/boot/
fi

echo ""
echo "✅ 安装完成！"
echo ""
echo "启动 Android Node:"
echo "  cd ~/android-node"
echo "  ./start.sh"
echo ""
echo "或直接运行:"
echo "  python ~/android-node/server.py"
