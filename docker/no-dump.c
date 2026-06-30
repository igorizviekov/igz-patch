#include <sys/prctl.h>
#include <unistd.h>

__attribute__((constructor)) static void disable_process_dumping(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) _exit(126);
}
