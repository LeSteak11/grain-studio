//! HEIC/HEIF to JPEG via Windows Imaging Component (uses the OS HEIF + HEVC extensions).
//! The webview can't decode HEIC, so iPhone photos are converted once on import.

use std::path::Path;
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::*;

pub fn to_jpeg(src: &Path, dst: &Path) -> Result<(), String> {
    unsafe { convert(src, dst) }.map_err(|e| {
        let _ = std::fs::remove_file(dst);
        format!(
            "HEIC decode failed ({}). Install \"HEIF Image Extensions\" and \"HEVC Video Extensions\" from the Microsoft Store.",
            e.message()
        )
    })
}

unsafe fn convert(src: &Path, dst: &Path) -> windows::core::Result<()> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
    let decoder = factory.CreateDecoderFromFilename(&HSTRING::from(src.as_os_str()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
    let frame = decoder.GetFrame(0)?;
    let source: IWICBitmapSource = frame.cast()?;

    let conv = factory.CreateFormatConverter()?;
    conv.Initialize(&source, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;
    let (mut w, mut h) = (0u32, 0u32);
    conv.GetSize(&mut w, &mut h)?;

    let stream = factory.CreateStream()?;
    stream.InitializeFromFilename(&HSTRING::from(dst.as_os_str()), GENERIC_WRITE.0)?;
    let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
    encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
    let mut fe: Option<IWICBitmapFrameEncode> = None;
    encoder.CreateNewFrame(&mut fe, std::ptr::null_mut())?;
    let fe = fe.ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(-1)))?;
    fe.Initialize(None)?;
    fe.SetSize(w, h)?;
    let mut fmt = GUID_WICPixelFormat24bppBGR;
    fe.SetPixelFormat(&mut fmt)?;
    fe.WriteSource(&conv, std::ptr::null())?;
    fe.Commit()?;
    encoder.Commit()?;
    Ok(())
}
