import './style.css'
import { ImageMagick, initializeImageMagick, MagickFormat, CompositeOperator, Point } from '@imagemagick/magick-wasm'
import magickWasm from '@imagemagick/magick-wasm/magick.wasm?url'

// Application state
interface AppState {
  originalImage: HTMLImageElement | null
  currentImage: HTMLImageElement | null
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  targetWidth: number
  targetHeight: number
  offsetX: number
  offsetY: number
  alignment: 'left' | 'center' | 'right'
  backgroundColor: string
  backgroundMode: 'color' | 'blur'
  aspectRatio: string
}

const state: AppState = {
  originalImage: null,
  currentImage: null,
  canvas: null,
  ctx: null,
  targetWidth: 800,
  targetHeight: 600,
  offsetX: 0,
  offsetY: 0,
  alignment: 'center',
  backgroundColor: '#ffffff',
  backgroundMode: 'color',
  aspectRatio: 'custom'
}

// DOM elements
const elements = {
  uploadArea: document.getElementById('uploadArea') as HTMLDivElement,
  fileInput: document.getElementById('fileInput') as HTMLInputElement,
  uploadSection: document.getElementById('uploadSection') as HTMLDivElement,
  previewSection: document.getElementById('previewSection') as HTMLDivElement,
  controlBar: document.getElementById('controlBar') as HTMLDivElement,
  canvas: document.getElementById('previewCanvas') as HTMLCanvasElement,
  widthInput: document.getElementById('widthInput') as HTMLInputElement,
  heightInput: document.getElementById('heightInput') as HTMLInputElement,
  bgColorPicker: document.getElementById('bgColorPicker') as HTMLInputElement,
  downloadBtn: document.getElementById('downloadBtn') as HTMLButtonElement,
  resetBtn: document.getElementById('resetBtn') as HTMLButtonElement
}

// Initialize ImageMagick
let magickInitialized = false

async function initializeMagick() {
  if (!magickInitialized) {
    try {
      await initializeImageMagick(new URL(magickWasm, import.meta.url))
      magickInitialized = true
      console.log('ImageMagick initialized successfully')
    } catch (error) {
      console.error('Failed to initialize ImageMagick:', error)
    }
  }
}

// Utility functions
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 }
}

function calculateAspectRatio(ratio: string, currentWidth: number, currentHeight: number): { width: number; height: number } {
  switch (ratio) {
    case '1:1':
      // Use the larger dimension as base to maximize resolution
      const maxDimension = Math.max(currentWidth, currentHeight)
      return { width: maxDimension, height: maxDimension }
    case '16:9':
      // Calculate both possibilities and choose the one with larger area
      const option1_16_9 = { width: currentHeight * 16 / 9, height: currentHeight }
      const option2_16_9 = { width: currentWidth, height: currentWidth * 9 / 16 }
      return option1_16_9.width * option1_16_9.height > option2_16_9.width * option2_16_9.height ? option1_16_9 : option2_16_9
    case '4:3':
      // Calculate both possibilities and choose the one with larger area
      const option1_4_3 = { width: currentHeight * 4 / 3, height: currentHeight }
      const option2_4_3 = { width: currentWidth, height: currentWidth * 3 / 4 }
      return option1_4_3.width * option1_4_3.height > option2_4_3.width * option2_4_3.height ? option1_4_3 : option2_4_3
    case '3:2':
      // Calculate both possibilities and choose the one with larger area
      const option1_3_2 = { width: currentHeight * 3 / 2, height: currentHeight }
      const option2_3_2 = { width: currentWidth, height: currentWidth * 2 / 3 }
      return option1_3_2.width * option1_3_2.height > option2_3_2.width * option2_3_2.height ? option1_3_2 : option2_3_2
    default:
      return { width: currentWidth, height: currentHeight }
  }
}

// Image processing functions
async function processImageWithMagick(imageData: Uint8Array, targetWidth: number, targetHeight: number, bgColor: string, bgMode: string, offsetX: number, offsetY: number): Promise<Uint8Array> {
  await initializeMagick()
  
  return new Promise((resolve, reject) => {
    try {
      ImageMagick.read(imageData, (img) => {
        try {
          const originalWidth = img.width
          const originalHeight = img.height
          
          // Create a new canvas with target dimensions and background color
          ImageMagick.read(`canvas:${bgColor}`, (canvas) => {
            try {
              canvas.resize(targetWidth, targetHeight)
              
              if (bgMode === 'blur' && state.originalImage) {
                // Create blurred background
                img.clone((blurredImg) => {
                  blurredImg.resize(targetWidth, targetHeight)
                  blurredImg.blur(0, 8)
                  canvas.composite(blurredImg, CompositeOperator.Over, new Point(0, 0))
                  blurredImg.dispose()
                })
              }
              
              // Calculate scaling to fit image while maintaining aspect ratio
              const scaleX = targetWidth / originalWidth
              const scaleY = targetHeight / originalHeight
              const scale = Math.min(scaleX, scaleY)
              
              const scaledWidth = Math.round(originalWidth * scale)
              const scaledHeight = Math.round(originalHeight * scale)
              
              // Calculate position based on alignment and offset
              let x = offsetX
              let y = offsetY
              
              if (state.alignment === 'center') {
                x += Math.round((targetWidth - scaledWidth) / 2)
                y += Math.round((targetHeight - scaledHeight) / 2)
              } else if (state.alignment === 'right') {
                x += targetWidth - scaledWidth
                y += Math.round((targetHeight - scaledHeight) / 2)
              } else {
                y += Math.round((targetHeight - scaledHeight) / 2)
              }
              
              // Resize and composite the image
              img.clone((resizedImg) => {
                resizedImg.resize(scaledWidth, scaledHeight)
                canvas.composite(resizedImg, CompositeOperator.Over, new Point(x, y))
                
                // Get the result
                canvas.write(MagickFormat.Png, (data) => {
                  resolve(data)
                  resizedImg.dispose()
                  canvas.dispose()
                  img.dispose()
                })
              })
            } catch (error) {
              canvas.dispose()
              img.dispose()
              reject(error)
            }
          })
        } catch (error) {
          img.dispose()
          reject(error)
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}

// Canvas rendering functions
function drawImageToCanvas() {
  if (!state.canvas || !state.ctx || !state.currentImage) return
  
  state.canvas.width = state.targetWidth
  state.canvas.height = state.targetHeight
  
  // Clear canvas
  state.ctx.clearRect(0, 0, state.targetWidth, state.targetHeight)
  
  // Draw background
  if (state.backgroundMode === 'color') {
    state.ctx.fillStyle = state.backgroundColor
    state.ctx.fillRect(0, 0, state.targetWidth, state.targetHeight)
  } else if (state.backgroundMode === 'blur' && state.originalImage) {
    // Draw blurred background
    state.ctx.filter = 'blur(8px)'
    state.ctx.drawImage(state.originalImage, 0, 0, state.targetWidth, state.targetHeight)
    state.ctx.filter = 'none'
  }
  
  // Calculate scaling and positioning
  const scaleX = state.targetWidth / state.currentImage.naturalWidth
  const scaleY = state.targetHeight / state.currentImage.naturalHeight
  const scale = Math.min(scaleX, scaleY)
  
  const scaledWidth = state.currentImage.naturalWidth * scale
  const scaledHeight = state.currentImage.naturalHeight * scale
  
  let x = state.offsetX
  let y = state.offsetY
  
  if (state.alignment === 'center') {
    x += (state.targetWidth - scaledWidth) / 2
    y += (state.targetHeight - scaledHeight) / 2
  } else if (state.alignment === 'right') {
    x += state.targetWidth - scaledWidth
    y += (state.targetHeight - scaledHeight) / 2
  } else {
    y += (state.targetHeight - scaledHeight) / 2
  }
  
  // Draw the image
  state.ctx.drawImage(state.currentImage, x, y, scaledWidth, scaledHeight)
}

// File handling
function handleFileSelect(file: File) {
  if (!file.type.startsWith('image/')) {
    alert('Please select a valid image file.')
    return
  }
  
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      state.originalImage = img
      state.currentImage = img
      state.canvas = elements.canvas
      state.ctx = elements.canvas.getContext('2d')
      
      // Set default resolution to original image dimensions
      state.targetWidth = img.naturalWidth
      state.targetHeight = img.naturalHeight
      elements.widthInput.value = state.targetWidth.toString()
      elements.heightInput.value = state.targetHeight.toString()
      
      // Show preview section and control bar
      elements.uploadSection.style.display = 'none'
      elements.previewSection.style.display = 'block'
      elements.controlBar.style.display = 'flex'
      
      // Add fade-in animation
      elements.previewSection.classList.add('fade-in')
      elements.controlBar.classList.add('fade-in')
      
      // Reset offsets
      state.offsetX = 0
      state.offsetY = 0
      
      // Initial render
      drawImageToCanvas()
    }
    img.src = e.target?.result as string
  }
  reader.readAsDataURL(file)
}

// Event listeners
function setupEventListeners() {
  // File upload
  elements.uploadArea.addEventListener('click', () => {
    elements.fileInput.click()
  })
  
  elements.fileInput.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) handleFileSelect(file)
  })
  
  // Drag and drop
  elements.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault()
    elements.uploadArea.classList.add('dragover')
  })
  
  elements.uploadArea.addEventListener('dragleave', () => {
    elements.uploadArea.classList.remove('dragover')
  })
  
  elements.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault()
    elements.uploadArea.classList.remove('dragover')
    const file = e.dataTransfer?.files[0]
    if (file) handleFileSelect(file)
  })
  
  // Aspect ratio buttons
  document.querySelectorAll('.aspect-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const ratio = target.dataset.ratio!
      
      // Update active state
      document.querySelectorAll('.aspect-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      
      state.aspectRatio = ratio
      
      if (ratio !== 'custom' && state.originalImage) {
        // Always use original image dimensions as the source for aspect ratio calculations
        const originalWidth = state.originalImage.naturalWidth
        const originalHeight = state.originalImage.naturalHeight
        const newDimensions = calculateAspectRatio(ratio, originalWidth, originalHeight)
        state.targetWidth = Math.round(newDimensions.width)
        state.targetHeight = Math.round(newDimensions.height)
        elements.widthInput.value = state.targetWidth.toString()
        elements.heightInput.value = state.targetHeight.toString()
        drawImageToCanvas()
      }
    })
  })
  
  // Resolution inputs
  elements.widthInput.addEventListener('input', () => {
    state.targetWidth = parseInt(elements.widthInput.value) || 800
    drawImageToCanvas()
  })
  
  elements.heightInput.addEventListener('input', () => {
    state.targetHeight = parseInt(elements.heightInput.value) || 600
    drawImageToCanvas()
  })
  
  // Alignment buttons
  document.querySelectorAll('.align-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const align = target.dataset.align as 'left' | 'center' | 'right'
      
      // Update active state
      document.querySelectorAll('.align-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      
      state.alignment = align
      state.offsetX = 0 // Reset offset when changing alignment
      drawImageToCanvas()
    })
  })
  
  // Arrow controls
  document.querySelectorAll('.arrow-btn').forEach(btn => {
    const direction = btn.getAttribute('data-direction')!
    let interval: number | null = null
    
    // Single click
    btn.addEventListener('click', () => {
      moveImage(direction, 1)
    })
    
    // Long press for continuous movement
    btn.addEventListener('mousedown', () => {
      setTimeout(() => {
        interval = setInterval(() => {
          moveImage(direction, 1)
        }, 50) as unknown as number
      }, 500) // Start continuous movement after 500ms
    })
    
    btn.addEventListener('mouseup', () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    })
    
    btn.addEventListener('mouseleave', () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    })
    
    // Touch events for mobile
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault()
      setTimeout(() => {
        interval = setInterval(() => {
          moveImage(direction, 1)
        }, 50) as unknown as number
      }, 500)
    })
    
    btn.addEventListener('touchend', (e) => {
      e.preventDefault()
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    })
  })
  
  // Background controls
  elements.bgColorPicker.addEventListener('input', () => {
    state.backgroundColor = elements.bgColorPicker.value
    drawImageToCanvas()
  })
  
  document.querySelectorAll('.bg-option-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement
      const bgMode = target.dataset.bg as 'color' | 'blur'
      
      // Update active state
      document.querySelectorAll('.bg-option-btn').forEach(b => b.classList.remove('active'))
      target.classList.add('active')
      
      state.backgroundMode = bgMode
      drawImageToCanvas()
    })
  })
  
  // Action buttons
  elements.downloadBtn.addEventListener('click', async () => {
    if (!state.canvas) return
    
    try {
      elements.downloadBtn.classList.add('loading')
      elements.downloadBtn.textContent = 'Processing...'
      
      // Convert canvas to blob and download
      state.canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `fitted-image-${state.targetWidth}x${state.targetHeight}.png`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
        }
        
        elements.downloadBtn.classList.remove('loading')
        elements.downloadBtn.textContent = 'Download'
      }, 'image/png')
    } catch (error) {
      console.error('Download failed:', error)
      elements.downloadBtn.classList.remove('loading')
      elements.downloadBtn.textContent = 'Download'
    }
  })
  
  elements.resetBtn.addEventListener('click', () => {
    // Reset to initial state
    state.offsetX = 0
    state.offsetY = 0
    state.alignment = 'center'
    
    // Reset to original image dimensions if available
    if (state.originalImage) {
      state.targetWidth = state.originalImage.naturalWidth
      state.targetHeight = state.originalImage.naturalHeight
      elements.widthInput.value = state.targetWidth.toString()
      elements.heightInput.value = state.targetHeight.toString()
    } else {
      state.targetWidth = 800
      state.targetHeight = 600
      elements.widthInput.value = '800'
      elements.heightInput.value = '600'
    }
    
    state.backgroundColor = '#ffffff'
    state.backgroundMode = 'color'
    state.aspectRatio = 'custom'
    
    // Reset UI
    elements.bgColorPicker.value = '#ffffff'
    
    // Reset active states
    document.querySelectorAll('.aspect-btn').forEach(b => b.classList.remove('active'))
    document.querySelector('.aspect-btn[data-ratio="custom"]')?.classList.add('active')
    
    document.querySelectorAll('.align-btn').forEach(b => b.classList.remove('active'))
    document.querySelector('.align-btn[data-align="center"]')?.classList.add('active')
    
    document.querySelectorAll('.bg-option-btn').forEach(b => b.classList.remove('active'))
    document.querySelector('.bg-option-btn[data-bg="color"]')?.classList.add('active')
    
    // Redraw
    drawImageToCanvas()
  })
}

function moveImage(direction: string, pixels: number) {
  switch (direction) {
    case 'up':
      state.offsetY -= pixels
      break
    case 'down':
      state.offsetY += pixels
      break
    case 'left':
      state.offsetX -= pixels
      break
    case 'right':
      state.offsetX += pixels
      break
  }
  drawImageToCanvas()
}

// Initialize the application
function init() {
  setupEventListeners()
  
  // Initialize ImageMagick in the background
  initializeMagick().catch(console.error)
}

// Start the application
init()
