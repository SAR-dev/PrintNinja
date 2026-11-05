//! Phase 0 spike for `docs/planned/DIRECT_PRINTING.md` — probes real hardware.
//!
//! Windows only. Run from the repo root with the printer attached:
//!
//! ```text
//! cd src-tauri
//! cargo run --example direct_print_spike -- usb                 # open test + 1284 ID + 1 KB write speed
//! cargo run --example direct_print_spike -- usb --kb 100         # 100 KB (prints a strip of noise)
//! cargo run --example direct_print_spike -- usb-wait 60          # poll; send a spooler job mid-window
//! cargo run --example direct_print_spike -- mapping              # queue <-> device ContainerId table
//! cargo run --example direct_print_spike -- queues               # Windows print queues
//! cargo run --example direct_print_spike -- pause "Queue Name"   # pause + work offline (SetPrinterW)
//! cargo run --example direct_print_spike -- resume "Queue Name"
//! cargo run --example direct_print_spike -- bt AA:BB:CC:DD:EE:FF            # RFCOMM SPP write (100 KB)
//! cargo run --example direct_print_spike -- bt AA:BB:CC:DD:EE:FF --kb 1     # shorter
//! cargo run --example direct_print_spike -- ble-scan 15
//! cargo run --example direct_print_spike -- ble AA:BB:CC:DD:EE:FF           # connect, MTU, chars, 100 KB write
//! ```
//!
//! Nothing here writes app state. The USB/BT/BLE write subcommands feed the
//! printer real bytes, so it will print — budget paper.

#[cfg(windows)]
mod spike;

fn main() {
    #[cfg(windows)]
    {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            if let Err(e) = spike::run(std::env::args().skip(1).collect()).await {
                eprintln!("spike failed: {e:#}");
                std::process::exit(1);
            }
        });
    }
    #[cfg(not(windows))]
    {
        eprintln!("direct_print_spike only runs on Windows.");
    }
}
